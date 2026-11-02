export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  return Response.json(
    { revision: process.env.AIEAS_REVISION ?? null, ok: true },
    { headers: { 'Cache-Control': 'no-store, max-age=0' } },
  );
}
