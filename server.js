// FMCSA lookup backend for the Diesel Service invoicing app.
// Takes a USDOT number, calls the FMCSA QCMobile API server-side
// (no CORS limits on a server), and returns clean carrier data.
//
// The FMCSA web key is read from an environment variable (FMCSA_KEY)
// so it never lives in your code or in the browser.

const express = require('express');
const app = express();

const FMCSA_KEY = process.env.FMCSA_KEY;       // set this in Render's Environment tab
const PORT = process.env.PORT || 3000;          // Render provides PORT automatically

// --- Allow only your own site(s) to call this service ---
// Locked to dieselservice.io. The onrender.com URL is also allowed so you can
// still test the backend directly. To add more sites later, add them to this list
// or set the ALLOWED_ORIGINS env var (comma-separated) in Render.
const DEFAULT_ALLOWED = [
  'https://dieselservice.io',
  'https://www.dieselservice.io',
  'https://dieselservice-app.onrender.com'
];
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
  : DEFAULT_ALLOWED);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// --- Health check so you can confirm the service is alive ---
app.get('/', (req, res) => {
  res.json({ ok: true, service: 'fmcsa-lookup', keyConfigured: !!FMCSA_KEY });
});

// --- The lookup endpoint: /carrier/1234567 ---
app.get('/carrier/:usdot', async (req, res) => {
  const usdot = String(req.params.usdot || '').trim();

  if (!/^\d{2,8}$/.test(usdot)) {
    return res.status(400).json({ error: 'Invalid USDOT number.' });
  }
  if (!FMCSA_KEY) {
    return res.status(500).json({ error: 'Server is missing FMCSA_KEY. Set it in Render Environment settings.' });
  }

  const deadline = AbortSignal.timeout(20000);
  try {
    const url = `https://mobile.fmcsa.dot.gov/qc/services/carriers/${usdot}?webKey=${encodeURIComponent(FMCSA_KEY)}`;
    // Bound a stalled provider request, including consumption of its JSON body.
    const fmcsaResp = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: deadline
    });

    if (!fmcsaResp.ok) {
      return res.status(502).json({ error: `FMCSA returned HTTP ${fmcsaResp.status}.` });
    }

    const data = await fmcsaResp.json();
    const c = (data && data.content && (data.content.carrier || data.content)) || {};

    if (!c.legalName) {
      return res.status(404).json({ error: `No carrier found for USDOT ${usdot}.` });
    }

    // Return only the fields the invoicing app needs, in a clean shape.
    res.json({
      usdot,
      legalName: c.legalName || '',
      dba: c.dbaName || '',
      addr: c.phyStreet || '',
      city: c.phyCity || '',
      state: c.phyState || '',
      zip: c.phyZipcode || '',
      phone: c.telephone || '',
      mcNumber: c.mcNumber || c.mcs150Number || '',
      safetyRating: c.safetyRating || '',
      powerUnits: c.totalPowerUnits || '',
      drivers: c.totalDrivers || ''
    });
  } catch (err) {
    if (deadline.aborted) {
      return res.status(504).json({ error: 'FMCSA lookup timed out. Please try again.' });
    }
    // Transport/parser errors can contain the web-key URL or provider content.
    res.status(500).json({ error: 'Lookup failed. Please try again.' });
  }
});

app.listen(PORT, () => {
  console.log(`FMCSA lookup service running on port ${PORT}`);
});
