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

// --- Allow your invoicing app (any origin) to call this service ---
// For internal use, "*" is fine. When you go commercial you can lock this
// down to just your real domain(s).
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
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

  try {
    const url = `https://mobile.fmcsa.dot.gov/qc/services/carriers/${usdot}?webKey=${encodeURIComponent(FMCSA_KEY)}`;
    const fmcsaResp = await fetch(url, { headers: { Accept: 'application/json' } });

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
    res.status(500).json({ error: 'Lookup failed: ' + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`FMCSA lookup service running on port ${PORT}`);
});
