export default function Home() {
  return (
    <main>
      <h1>saas-billing-starter</h1>
      <p>Demo project. The interesting parts are server-side:</p>
      <ul>
        <li><code>db/schema.sql</code>: orgs, members and roles with row-level security</li>
        <li><code>POST /api/stripe/webhook</code>: signed, idempotent subscription sync</li>
      </ul>
    </main>
  );
}
