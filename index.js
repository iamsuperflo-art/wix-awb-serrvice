// index.js — server standalone pentru generarea AWB-urilor (FanCourier + DPD)
const express = require('express');
const awbRouter = require('./awb-router');

const app = express();
app.use(express.json({ limit: '2mb' })); // comenzile Wix sunt mari

// healthcheck
app.get('/', (req, res) => res.json({ ok: true, service: 'wix-awb' }));

app.use(awbRouter);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('AWB service pornit pe portul ' + PORT));
