import "./globals.css";

export const metadata = {
  title: "CinchPOS Billing Dashboard",
  description: "CinchPOS ERP billing workspace"
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" data-scroll-behavior="smooth">
      <body>{children}</body>
    </html>
  );
}
