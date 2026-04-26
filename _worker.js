// _worker.js – Cloudflare Pages Advanced Worker (handles API & static assets)

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const ua = (request.headers.get('User-Agent') || '').toLowerCase();

    // Block scrapers
    if (/wget|curl|python-requests|scrapy|axios|node-fetch/i.test(ua)) {
      return new Response('Forbidden', { status: 403 });
    }

    // CORS headers for API routes
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Code, X-Est-Code'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      let response;

      if (path.startsWith('/api/admin')) {
        response = await handleAdmin(request, env);
      } else if (path.startsWith('/api/establishment')) {
        response = await handleEstablishment(request, env);
      } else if (path.startsWith('/api/public')) {
        response = await handlePublic(request, env);
      } else {
        // Serve static assets from Pages
        return env.ASSETS.fetch(request);
      }

      // Attach CORS to all API responses
      const newHeaders = new Headers(response.headers);
      for (const [k, v] of Object.entries(corsHeaders)) {
        newHeaders.set(k, v);
      }
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders
      });
    } catch (err) {
      const errorResponse = Response.json(
        { error: err.message || 'Internal Server Error' },
        { status: err.message === 'Unauthorized' ? 401 : 500 }
      );
      const newHeaders = new Headers(errorResponse.headers);
      for (const [k, v] of Object.entries(corsHeaders)) {
        newHeaders.set(k, v);
      }
      return new Response(errorResponse.body, {
        status: errorResponse.status,
        headers: newHeaders
      });
    }
  }
};

// ---------- Authentication helpers ----------
function getAdminCode(request) {
  return request.headers.get('X-Admin-Code');
}
function getEstablishmentCode(request) {
  return request.headers.get('X-Est-Code');
}

async function authAdmin(env, request) {
  const code = getAdminCode(request);
  if (!code || code !== env.ADMIN_CODE) throw new Error('Unauthorized');
}

async function authEstablishment(env, request) {
  const code = getEstablishmentCode(request);
  if (!code) throw new Error('Unauthorized');
  const result = await env.DB.prepare(
    'SELECT id, name FROM establishments WHERE login_code = ?'
  ).bind(code).first();
  if (!result) throw new Error('Invalid establishment code');
  return result; // { id, name }
}

// ---------- Admin handlers ----------
async function handleAdmin(request, env) {
  await authAdmin(env, request);
  const url = new URL(request.url);
  const path = url.pathname.replace('/api/admin', '');

  if (request.method === 'GET') {
    if (path === '/wilayas') {
      const { results } = await env.DB.prepare('SELECT * FROM wilayas ORDER BY id').all();
      return Response.json(results);
    }
    if (path === '/communes' && url.searchParams.has('wilaya_id')) {
      const wid = url.searchParams.get('wilaya_id');
      const { results } = await env.DB.prepare(
        'SELECT * FROM communes WHERE wilaya_id = ? ORDER BY name'
      ).bind(wid).all();
      return Response.json(results);
    }
    if (path === '/pharmacies') {
      const { results } = await env.DB.prepare(
        'SELECT p.*, w.name as wilaya, c.name as commune FROM pharmacies p JOIN wilayas w ON p.wilaya_id = w.id JOIN communes c ON p.commune_id = c.id ORDER BY p.id'
      ).all();
      return Response.json(results);
    }
    if (path === '/establishments') {
      const { results } = await env.DB.prepare(
        'SELECT e.*, w.name as wilaya, c.name as commune FROM establishments e LEFT JOIN wilayas w ON e.wilaya_id = w.id LEFT JOIN communes c ON e.commune_id = c.id ORDER BY e.id'
      ).all();
      return Response.json(results);
    }
  }

  if (request.method === 'POST') {
    const body = await request.json();

    if (path === '/wilaya') {
      const { name, name_ar } = body;
      const result = await env.DB.prepare(
        'INSERT INTO wilayas (name, name_ar) VALUES (?, ?) RETURNING *'
      ).bind(name, name_ar || null).first();
      return Response.json(result);
    }
    if (path === '/commune') {
      const { wilaya_id, name, name_ar } = body;
      const result = await env.DB.prepare(
        'INSERT INTO communes (wilaya_id, name, name_ar) VALUES (?, ?, ?) RETURNING *'
      ).bind(wilaya_id, name, name_ar || null).first();
      return Response.json(result);
    }
    if (path === '/pharmacy') {
      const { name, phone, address, lat, lng, commune_id, notes } = body;
      // Determine wilaya_id from commune
      const commune = await env.DB.prepare(
        'SELECT wilaya_id FROM communes WHERE id = ?'
      ).bind(commune_id).first();
      if (!commune) throw new Error('Commune not found');
      const result = await env.DB.prepare(
        'INSERT INTO pharmacies (name, phone, address, lat, lng, commune_id, wilaya_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *'
      ).bind(name, phone || null, address || null, lat, lng, commune_id, commune.wilaya_id, notes || null).first();
      return Response.json(result);
    }
    if (path === '/night-duty') {
      const { pharmacy_id, duty_date, start_time, end_time } = body;
      await env.DB.prepare(
        'INSERT INTO night_duty_plans (pharmacy_id, duty_date, start_time, end_time) VALUES (?, ?, ?, ?) ON CONFLICT(pharmacy_id, duty_date) DO UPDATE SET start_time=?, end_time=?'
      ).bind(pharmacy_id, duty_date, start_time, end_time, start_time, end_time).run();
      return Response.json({ success: true });
    }
    if (path === '/establishment') {
      const { name, wilaya_id, commune_id, address, phone } = body;
      // Generate a random 8-char alphanumeric login code
      const login_code = Array.from({length: 8}, () => Math.random().toString(36)[2]).join('');
      const result = await env.DB.prepare(
        'INSERT INTO establishments (name, login_code, wilaya_id, commune_id, address, phone) VALUES (?, ?, ?, ?, ?, ?) RETURNING *'
      ).bind(name, login_code, wilaya_id || null, commune_id || null, address || null, phone || null).first();
      return Response.json(result);
    }
  }

  if (request.method === 'DELETE') {
    if (path.startsWith('/pharmacy/')) {
      const id = path.split('/')[2];
      await env.DB.prepare('DELETE FROM pharmacies WHERE id = ?').bind(id).run();
      return Response.json({ success: true });
    }
    if (path.startsWith('/establishment/')) {
      const id = path.split('/')[2];
      await env.DB.prepare('DELETE FROM establishments WHERE id = ?').bind(id).run();
      return Response.json({ success: true });
    }
    if (path.startsWith('/night-duty/')) {
      const id = path.split('/')[2];
      await env.DB.prepare('DELETE FROM night_duty_plans WHERE id = ?').bind(id).run();
      return Response.json({ success: true });
    }
  }

  return new Response('Not Found', { status: 404 });
}

// ---------- Establishment self-management ----------
async function handleEstablishment(request, env) {
  const est = await authEstablishment(env, request);
  const url = new URL(request.url);
  const path = url.pathname.replace('/api/establishment', '');

  if (request.method === 'GET') {
    if (path === '/profile') {
      const profile = await env.DB.prepare(
        'SELECT e.*, w.name as wilaya, c.name as commune FROM establishments e LEFT JOIN wilayas w ON e.wilaya_id = w.id LEFT JOIN communes c ON e.commune_id = c.id WHERE e.id = ?'
      ).bind(est.id).first();
      return Response.json(profile);
    }
    if (path === '/specialists') {
      const { results } = await env.DB.prepare(
        'SELECT * FROM specialists WHERE establishment_id = ? ORDER BY id'
      ).bind(est.id).all();
      return Response.json(results);
    }
  }

  if (request.method === 'POST') {
    if (path === '/specialist') {
      const body = await request.json();
      const { name, specialty, working_hours, consultation_place, extra_details } = body;
      const result = await env.DB.prepare(
        'INSERT INTO specialists (establishment_id, name, specialty, working_hours, consultation_place, extra_details) VALUES (?, ?, ?, ?, ?, ?) RETURNING *'
      ).bind(est.id, name, specialty, working_hours || null, consultation_place || null, extra_details || null).first();
      return Response.json(result);
    }
  }

  if (request.method === 'PUT') {
    if (path.startsWith('/specialist/')) {
      const specialistId = path.split('/')[2];
      const body = await request.json();
      const { name, specialty, working_hours, consultation_place, extra_details } = body;
      // Verify establishment owns this specialist
      const specialist = await env.DB.prepare(
        'SELECT * FROM specialists WHERE id = ? AND establishment_id = ?'
      ).bind(specialistId, est.id).first();
      if (!specialist) throw new Error('Not found or not authorized');
      await env.DB.prepare(
        'UPDATE specialists SET name=?, specialty=?, working_hours=?, consultation_place=?, extra_details=? WHERE id=?'
      ).bind(name, specialty, working_hours || null, consultation_place || null, extra_details || null, specialistId).run();
      return Response.json({ success: true });
    }
  }

  if (request.method === 'DELETE') {
    if (path.startsWith('/specialist/')) {
      const specialistId = path.split('/')[2];
      await env.DB.prepare(
        'DELETE FROM specialists WHERE id = ? AND establishment_id = ?'
      ).bind(specialistId, est.id).run();
      return Response.json({ success: true });
    }
  }

  return new Response('Not Found', { status: 404 });
}

// ---------- Public API ----------
async function handlePublic(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace('/api/public', '');

  if (path === '/wilayas') {
    const { results } = await env.DB.prepare('SELECT * FROM wilayas ORDER BY id').all();
    return Response.json(results);
  }
  if (path === '/communes') {
    const wid = url.searchParams.get('wilaya_id');
    if (wid) {
      const { results } = await env.DB.prepare(
        'SELECT * FROM communes WHERE wilaya_id = ? ORDER BY name'
      ).bind(wid).all();
      return Response.json(results);
    }
    return Response.json([]);
  }
  if (path === '/pharmacies-on-duty') {
    const date = url.searchParams.get('date') || new Date().toISOString().slice(0,10);
    const time = url.searchParams.get('time') || new Date().toTimeString().slice(0,5);
    const wilaya_id = url.searchParams.get('wilaya_id');
    const commune_id = url.searchParams.get('commune_id');

    let query = `
      SELECT p.id, p.name, p.phone, p.lat, p.lng, p.address,
             w.name as wilaya, c.name as commune
      FROM night_duty_plans n
      JOIN pharmacies p ON n.pharmacy_id = p.id
      JOIN wilayas w ON p.wilaya_id = w.id
      JOIN communes c ON p.commune_id = c.id
      WHERE n.duty_date = ?1 AND n.start_time <= ?2 AND n.end_time >= ?2
    `;
    const params = [date, time];
    if (wilaya_id) {
      query += ` AND p.wilaya_id = ?3`;
      params.push(wilaya_id);
    }
    if (commune_id) {
      query += ` AND p.commune_id = ?4`;
      params.push(commune_id);
    }
    const { results } = await env.DB.prepare(query).bind(...params).all();
    return Response.json(results);
  }
  if (path === '/specialists') {
    const specialty = url.searchParams.get('specialty');
    const name = url.searchParams.get('name');
    const wilaya_id = url.searchParams.get('wilaya_id');

    let query = `
      SELECT s.*, e.name as establishment, e.address, e.phone,
             w.name as wilaya, c.name as commune
      FROM specialists s
      JOIN establishments e ON s.establishment_id = e.id
      LEFT JOIN wilayas w ON e.wilaya_id = w.id
      LEFT JOIN communes c ON e.commune_id = c.id
      WHERE 1=1
    `;
    const params = [];
    if (specialty) {
      query += ` AND s.specialty LIKE ?1`;
      params.push('%' + specialty + '%');
    }
    if (name) {
      query += ` AND (s.name LIKE ?${params.length+1} OR e.name LIKE ?${params.length+1})`;
      params.push('%' + name + '%');
    }
    if (wilaya_id) {
      query += ` AND e.wilaya_id = ?${params.length+1}`;
      params.push(wilaya_id);
    }
    const { results } = await env.DB.prepare(query).bind(...params).all();
    return Response.json(results);
  }
  return new Response('Not Found', { status: 404 });
}