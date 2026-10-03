import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
  "Content-Type": "text/csv; charset=utf-8",
  "Cache-Control": "public, max-age=900, s-maxage=900",
  "X-Content-Type-Options": "nosniff"
};

function csv(value: unknown): string {
  return '"' + String(value ?? '').replace(/"/g, '""') + '"';
}

function slug(value: unknown): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function publicKey(): { key: string; legacy: boolean } | null {
  const legacy = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  if (legacy) return { key: legacy, legacy: true };

  const direct = Deno.env.get('SUPABASE_PUBLISHABLE_KEY') ?? '';
  if (direct) return { key: direct, legacy: false };

  try {
    const named = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') ?? '{}');
    const key = typeof named.default === 'string' ? named.default : '';
    if (key) return { key, legacy: false };
  } catch { /* use an unavailable response below */ }
  return null;
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (!['GET', 'HEAD'].includes(request.method)) {
    return new Response('Method not allowed', { status: 405, headers: CORS });
  }

  const base = Deno.env.get('SUPABASE_URL');
  const credentials = publicKey();
  if (!base || !credentials) {
    return new Response('Catalog source unavailable', { status: 503, headers: CORS });
  }

  const url = new URL('/rest/v1/machines', base);
  url.searchParams.set('select', 'id,name,category,description,price_day,vat_included,image_url,available,active,deposit');
  url.searchParams.set('active', 'eq.true');
  url.searchParams.set('order', 'name.asc');

  const headers: Record<string, string> = { apikey: credentials.key };
  if (credentials.legacy) headers.Authorization = 'Bearer ' + credentials.key;

  try {
    const response = await fetch(url, { headers });
    if (!response.ok) {
      return new Response('Catalog source unavailable', { status: 503, headers: CORS });
    }
    const rows = await response.json() as Array<Record<string, unknown>>;
    const lines = [
      'id,title,description,availability,condition,price,link,image_link,brand,product_type'
    ];

    for (const row of rows) {
      const id = String(row.id ?? '');
      const name = String(row.name ?? '').trim();
      const basePrice = Number(row.price_day);
      const image = String(row.image_url ?? '');
      if (!id || !name || !Number.isFinite(basePrice) || basePrice <= 0 || !/^https:\/\//i.test(image)) continue;

      const includesVat = row.vat_included === true;
      const amount = Math.round((basePrice * (includesVat ? 1 : 1.21) + Number.EPSILON) * 100) / 100;
      const price = amount.toFixed(2) + ' EUR';
      const vatText = includesVat
        ? 'IVA incluido'
        : basePrice.toFixed(2) + ' EUR + IVA (' + amount.toFixed(2) + ' EUR IVA incluido)';
      const deposit = Number(row.deposit ?? 0);
      const description = 'Alquiler de ' + name + ' por 1 día. Tarifa base: ' + vatText +
        '. Fianza: ' + deposit.toFixed(2) + ' EUR. ' + String(row.description ?? '') +
        ' Consulta disponibilidad y condiciones en Catarroja, Valencia.';
      const link = new URL('/maquinaria/' + slug(name) + '/', 'https://rvmalquiler.es');
      link.searchParams.set('utm_source', 'facebook');
      link.searchParams.set('utm_medium', 'paid_social');
      link.searchParams.set('utm_campaign', 'rvm_alquiler_catalogo_valencia');
      link.searchParams.set('utm_content', id);

      lines.push([
        id,
        'Alquiler de ' + name + ' · 1 día',
        description,
        row.available === true ? 'in stock' : 'out of stock',
        'used',
        price,
        link.toString(),
        image,
        'RVM Serveis',
        'Alquiler > ' + String(row.category ?? 'Maquinaria')
      ].map(csv).join(','));
    }

    const body = lines.join('\r\n') + '\r\n';
    return new Response(request.method === 'HEAD' ? null : body, {
      status: 200,
      headers: {
        ...CORS,
        'Content-Disposition': 'attachment; filename="rvm-alquiler-catalog.csv"'
      }
    });
  } catch {
    return new Response('Catalog source unavailable', { status: 503, headers: CORS });
  }
});
