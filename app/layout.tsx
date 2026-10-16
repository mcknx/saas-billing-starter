export const metadata = { title: "saas-billing-starter" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui", maxWidth: 640, margin: "40px auto", padding: "0 16px" }}>{children}</body>
    </html>
  );
}
