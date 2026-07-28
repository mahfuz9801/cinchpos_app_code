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
    os.environ["CINCHPOS_AUTH_REQUIRED"] = "0"
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
        os.environ.pop("CINCHPOS_AUTH_REQUIRED", None)
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

    def test_customer_account_register_login_logout_and_snapshot(self):
        weak_response = self.client.post(
            "/api/auth/register",
            json={"username": "testshop", "password": "weak"},
        )
        self.assertEqual(weak_response.status_code, 400)

        register_response = self.client.post(
            "/api/auth/register",
            json={
                "username": "testshop",
                "password": "Strong#123",
                "confirm_password": "Strong#123",
                "name": "Test Shop",
                "email": "owner@example.com",
                "phone": "+919876543210",
                "business_name": "Test Shop Business",
            },
        )
        self.assertEqual(register_response.status_code, 201)
        register_payload = register_response.get_json()
        token = register_payload["token"]
        self.assertTrue(token.startswith("cinch_"))
        self.assertEqual(register_payload["account"]["username"], "testshop")
        self.assertRegex(register_payload["account"]["customer_id"], r"^CP\d{6}$")
        self.assertEqual(register_payload["context"]["username"], "testshop")
        self.assertEqual(register_payload["context"]["customer_id"], register_payload["account"]["customer_id"])

        duplicate_response = self.client.post(
            "/api/auth/register",
            json={
                "username": "testshop",
                "password": "Strong#123",
                "confirm_password": "Strong#123",
                "email": "other@example.com",
                "phone": "+919999999999",
                "business_name": "Duplicate Shop",
            },
        )
        self.assertEqual(duplicate_response.status_code, 409)
        self.assertEqual(duplicate_response.get_json()["error"], "This username is already registered.")

        email_otp_response = self.client.post(
            "/api/auth/otp/request",
            json={"identifier": "owner@example.com"},
        )
        self.assertEqual(email_otp_response.status_code, 200)
        email_otp_payload = email_otp_response.get_json()
        self.assertEqual(email_otp_payload["channel"], "email")
        self.assertTrue(email_otp_payload["dev_otp"])
        email_otp_login_response = self.client.post(
            "/api/auth/otp/verify",
            json={"identifier": "owner@example.com", "otp": email_otp_payload["dev_otp"]},
        )
        self.assertEqual(email_otp_login_response.status_code, 200)
        self.assertTrue(email_otp_login_response.get_json()["token"].startswith("cinch_"))

        phone_otp_response = self.client.post(
            "/api/auth/otp/request",
            json={"identifier": "+919876543210"},
        )
        self.assertEqual(phone_otp_response.status_code, 200)
        phone_otp_payload = phone_otp_response.get_json()
        self.assertEqual(phone_otp_payload["channel"], "phone")
        self.assertTrue(phone_otp_payload["dev_otp"])
        phone_otp_login_response = self.client.post(
            "/api/auth/otp/verify",
            json={"identifier": "9876543210", "otp": phone_otp_payload["dev_otp"]},
        )
        self.assertEqual(phone_otp_login_response.status_code, 200)
        self.assertTrue(phone_otp_login_response.get_json()["token"].startswith("cinch_"))

        auth_headers = {"Authorization": f"Bearer {token}"}
        context_response = self.client.get("/api/auth/context", headers=auth_headers)
        self.assertEqual(context_response.status_code, 200)
        self.assertEqual(context_response.get_json()["context"]["source"], "cinchpos-account")

        snapshot_response = self.client.put(
            "/api/workspace/snapshot",
            headers=auth_headers,
            json={"payload": {"inventoryItems": [{"name": "Cloud Item", "stock": 2}]}},
        )
        self.assertEqual(snapshot_response.status_code, 200)
        pulled_snapshot = self.client.get("/api/workspace/snapshot", headers=auth_headers)
        self.assertEqual(pulled_snapshot.status_code, 200)
        self.assertEqual(
            pulled_snapshot.get_json()["payload"]["inventoryItems"][0]["name"],
            "Cloud Item",
        )

        logout_response = self.client.post("/api/auth/logout", headers=auth_headers, json={})
        self.assertEqual(logout_response.status_code, 200)
        revoked_response = self.client.get("/api/auth/context", headers=auth_headers)
        self.assertEqual(revoked_response.status_code, 401)

        login_response = self.client.post(
            "/api/auth/login",
            json={"username": "testshop", "password": "Strong#123"},
        )
        self.assertEqual(login_response.status_code, 200)
        login_payload = login_response.get_json()
        self.assertTrue(login_payload["token"].startswith("cinch_"))
        self.assertEqual(login_payload["context"]["username"], "testshop")

    def test_account_owner_can_recover_previous_local_billing_data(self):
        local_customer = self.create_customer(name="Old Local Customer", phone="+919111111111")
        local_invoice_response = self.create_invoice(local_customer["id"], amount=300.0)
        self.assertEqual(local_invoice_response.status_code, 201)
        local_invoice = local_invoice_response.get_json()
        payment_response = self.client.post(
            "/api/payments",
            json={
                "invoice_id": local_invoice["id"],
                "amount": 125.0,
                "paid_on": self.backend.today_value().isoformat(),
                "method": "Cash",
                "notes": "Previous local payment",
            },
        )
        self.assertEqual(payment_response.status_code, 201)

        register_response = self.client.post(
            "/api/auth/register",
            json={
                "username": "recover-shop",
                "password": "Strong#123",
                "confirm_password": "Strong#123",
                "email": "recover@example.com",
                "business_name": "Recover Shop",
            },
        )
        self.assertEqual(register_response.status_code, 201)
        auth_headers = {"Authorization": f"Bearer {register_response.get_json()['token']}"}

        hidden_invoices_response = self.client.get("/api/invoices", headers=auth_headers)
        self.assertEqual(hidden_invoices_response.status_code, 200)
        self.assertEqual(hidden_invoices_response.get_json(), [])

        preview_response = self.client.get("/api/workspace/recover-local-billing", headers=auth_headers)
        self.assertEqual(preview_response.status_code, 200)
        preview = preview_response.get_json()
        self.assertTrue(preview["recoverable"])
        self.assertEqual(preview["local_counts"]["customers"], 1)
        self.assertEqual(preview["local_counts"]["invoices"], 1)
        self.assertEqual(preview["local_counts"]["payments"], 1)

        recover_response = self.client.post("/api/workspace/recover-local-billing", headers=auth_headers, json={})
        self.assertEqual(recover_response.status_code, 200)
        recovered = recover_response.get_json()
        self.assertEqual(recovered["recovered"]["customers"], 1)
        self.assertEqual(recovered["recovered"]["invoices"], 1)
        self.assertEqual(recovered["recovered"]["payments"], 1)
        self.assertTrue(os.path.isfile(recovered["backup_path"]))

        restored_invoices_response = self.client.get("/api/invoices", headers=auth_headers)
        self.assertEqual(restored_invoices_response.status_code, 200)
        restored_invoices = restored_invoices_response.get_json()
        self.assertEqual(len(restored_invoices), 1)
        self.assertEqual(restored_invoices[0]["invoice_number"], local_invoice["invoice_number"])

    def test_duplicate_invoice_number_returns_conflict(self):
        customer = self.create_customer()
        first = self.create_invoice(customer["id"], amount=250.0, invoice_number="INV-DUP")
        duplicate = self.create_invoice(
            customer["id"], amount=125.0, invoice_number="INV-DUP"
        )

        self.assertEqual(first.status_code, 201)
        self.assertEqual(duplicate.status_code, 409)
        self.assertEqual(
            duplicate.get_json()["error"],
            "Invoice number already exists. Leave it blank to auto-generate the next bill number.",
        )

    def test_auto_invoice_numbers_do_not_collide(self):
        customer = self.create_customer()
        first = self.create_invoice(customer["id"], amount=250.0)
        second = self.create_invoice(customer["id"], amount=125.0)

        self.assertEqual(first.status_code, 201)
        self.assertEqual(second.status_code, 201)
        first_payload = first.get_json()
        second_payload = second.get_json()
        self.assertNotEqual(first_payload["invoice_number"], second_payload["invoice_number"])
        self.assertTrue(first_payload["invoice_number"].startswith("INV-"))
        self.assertTrue(second_payload["invoice_number"].startswith("INV-"))

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

    def test_online_store_publish_checkout_and_invoice_download_data(self):
        publish_response = self.client.put(
            "/api/online-store/publish",
            json={
                "store": {
                    "store_name": "Ardh Sainik Canteen",
                    "contact_phone": "+919038956555",
                    "contact_email": "support@cinchpos.in",
                    "address": "Kolkata",
                    "logo_url": "/assets/logo-cinchpos-mark.png",
                },
                "products": [
                    {
                        "id": "vasline-90ml",
                        "name": "Vasline deep moisture 90ml",
                        "barcode": "8901030978449",
                        "barcodes": ["8901030978449"],
                        "category": "Personal Care",
                        "stock": 5,
                        "offlinePrice": 85,
                        "onlinePrice": 82,
                        "mrp": 90,
                        "gstRate": 18,
                    }
                ],
            },
        )

        self.assertEqual(publish_response.status_code, 200)
        published = publish_response.get_json()
        self.assertEqual(published["published_count"], 1)
        self.assertRegex(published["store"]["slug"], r"^ardh-sainik-canteen-\d{4}$")
        self.assertIn("/online-store", published["store"]["public_url"])

        store_slug = published["store"]["slug"]
        public_response = self.client.get(f"/api/public/stores/{store_slug}")
        self.assertEqual(public_response.status_code, 200)
        public_payload = public_response.get_json()
        self.assertEqual(public_payload["store"]["store_name"], "Ardh Sainik Canteen")
        self.assertEqual(len(public_payload["products"]), 1)
        self.assertEqual(public_payload["products"][0]["online_price"], 82.0)

        checkout_response = self.client.post(
            f"/api/public/stores/{store_slug}/checkout",
            json={
                "customer": {
                    "name": "Online Customer",
                    "phone": "9876543210",
                    "email": "customer@example.com",
                    "address": "Sample address",
                },
                "items": [{"product_key": "vasline-90ml", "quantity": 2}],
            },
        )
        self.assertEqual(checkout_response.status_code, 201)
        checkout_payload = checkout_response.get_json()
        self.assertTrue(checkout_payload["order"]["invoice_number"].startswith("WEB-"))
        self.assertEqual(checkout_payload["order"]["total"], 164.0)
        self.assertEqual(checkout_payload["order"]["discount_total"], 16.0)
        self.assertEqual(checkout_payload["order"]["items"][0]["quantity"], 2)

        refreshed_store = self.client.get(f"/api/public/stores/{store_slug}").get_json()
        self.assertEqual(refreshed_store["products"][0]["stock"], 3.0)

        invoice_response = self.client.get(
            f"/api/public/orders/{checkout_payload['order']['id']}/invoice"
        )
        self.assertEqual(invoice_response.status_code, 200)
        invoice_payload = invoice_response.get_json()
        self.assertEqual(invoice_payload["order"]["invoice_number"], checkout_payload["order"]["invoice_number"])
        self.assertEqual(invoice_payload["store"]["store_name"], "Ardh Sainik Canteen")


if __name__ == "__main__":
    unittest.main()
