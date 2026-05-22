import importlib
import os
import sys
import tempfile
import unittest
from contextlib import closing


BACKEND_DIR = os.path.dirname(os.path.dirname(__file__))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)


def load_backend(db_path):
    os.environ["DATABASE_PATH"] = db_path
    sys.modules.pop("app", None)
    import app

    return importlib.reload(app)


class CinchPOSAPITestCase(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self.temp_dir.name, "cinchpos-test.db")
        self.backend = load_backend(self.db_path)
        self.client = self.backend.app.test_client()

    def tearDown(self):
        os.environ.pop("DATABASE_PATH", None)
        self.temp_dir.cleanup()

    def create_customer(self, name="Northwind", phone="+919876543210"):
        response = self.client.post(
            "/api/customers",
            json={"name": name, "email": "billing@example.com", "phone": phone},
        )
        self.assertEqual(response.status_code, 201)
        return response.get_json()

    def create_invoice(self, customer_id, amount=120.0, invoice_number="", due_on=None):
        issued_on = self.backend.today_value().isoformat()
        response = self.client.post(
            "/api/invoices",
            json={
                "customer_id": customer_id,
                "invoice_number": invoice_number,
                "amount": amount,
                "issued_on": issued_on,
                "due_on": due_on or issued_on,
                "notes": "Test invoice",
            },
        )
        return response

    def test_schema_metadata_is_initialized(self):
        with closing(self.backend.get_connection()) as conn:
            row = conn.execute(
                "SELECT meta_value FROM app_meta WHERE meta_key = ?",
                ("schema_version",),
            ).fetchone()

        self.assertIsNotNone(row)
        self.assertEqual(row["meta_value"], self.backend.SCHEMA_VERSION)

    def test_health_endpoint_reports_ready_database(self):
        response = self.client.get("/api/health")

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["status"], "ok")
        self.assertEqual(payload["schema_version"], self.backend.SCHEMA_VERSION)
        self.assertTrue(payload["database"].endswith(".db"))

    def test_duplicate_invoice_number_returns_conflict(self):
        customer = self.create_customer()
        first = self.create_invoice(customer["id"], amount=250.0, invoice_number="INV-DUP")
        duplicate = self.create_invoice(
            customer["id"], amount=125.0, invoice_number="INV-DUP"
        )

        self.assertEqual(first.status_code, 201)
        self.assertEqual(duplicate.status_code, 409)
        self.assertEqual(
            duplicate.get_json()["error"], "Invoice number already exists."
        )

    def test_customer_update_endpoint_overwrites_contact_fields(self):
        customer = self.create_customer(name="Legacy Name", phone="+919999111122")

        response = self.client.put(
            f"/api/customers/{customer['id']}",
            json={
                "name": "Updated Name",
                "email": "updated@example.com",
                "phone": "+919876543210",
            },
        )

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["name"], "Updated Name")
        self.assertEqual(payload["email"], "updated@example.com")
        self.assertEqual(payload["phone"], "+919876543210")

    def test_partial_payment_updates_invoice_and_dashboard_totals(self):
        customer = self.create_customer()
        invoice_response = self.create_invoice(customer["id"], amount=120.0)
        self.assertEqual(invoice_response.status_code, 201)
        invoice = invoice_response.get_json()

        payment_response = self.client.post(
            "/api/payments",
            json={
                "invoice_id": invoice["id"],
                "amount": 50.0,
                "paid_on": self.backend.today_value().isoformat(),
                "method": "Cash",
                "notes": "Partial payment",
            },
        )
        self.assertEqual(payment_response.status_code, 201)

        invoices = self.client.get("/api/invoices").get_json()
        self.assertEqual(len(invoices), 1)
        self.assertEqual(invoices[0]["status"], "Pending")
        self.assertEqual(invoices[0]["total_paid"], 50.0)
        self.assertEqual(invoices[0]["outstanding"], 70.0)

        dashboard = self.client.get("/api/dashboard").get_json()
        self.assertEqual(dashboard["summary"]["invoice_count"], 1)
        self.assertEqual(dashboard["summary"]["outstanding_payments"], 70.0)

    def test_trend_endpoint_returns_custom_range_points(self):
        customer = self.create_customer()
        invoice = self.create_invoice(customer["id"], amount=200.0).get_json()

        self.client.post(
            "/api/payments",
            json={
                "invoice_id": invoice["id"],
                "amount": 200.0,
                "paid_on": "2026-04-30",
                "method": "UPI",
                "notes": "Paid in full",
            },
        )

        trend_response = self.client.get(
            "/api/dashboard/trend?view=custom&start_date=2026-04-29&end_date=2026-04-30"
        )

        self.assertEqual(trend_response.status_code, 200)
        payload = trend_response.get_json()
        self.assertEqual(payload["view"], "custom")
        self.assertEqual(len(payload["points"]), 2)
        self.assertEqual(payload["points"][1]["value"], 200.0)


if __name__ == "__main__":
    unittest.main()
