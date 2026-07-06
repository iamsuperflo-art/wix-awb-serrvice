// couriers/fancourier.js
// FanCourier API v2 (api.fancourier.ro) — folosit pentru comenzile din Bucuresti (judet RO-B)
// Docs: https://www.fancourier.ro/wp-content/uploads/2025/09/EN_FANCourier_API_130825-1.pdf

const BASE = 'https://api.fancourier.ro';

const USERNAME    = process.env.FANCOURIER_USERNAME;
const PASSWORD    = process.env.FANCOURIER_PASSWORD;
const CLIENT_ID   = process.env.FANCOURIER_CLIENT_ID;                       // clientId numeric din selfAWB
const SERVICE     = process.env.FANCOURIER_SERVICE     || 'Standard';
const SERVICE_COD = process.env.FANCOURIER_SERVICE_COD || 'Cont Colector';  // pt. ramburs incasat in cont
const PAYMENT     = process.env.FANCOURIER_PAYMENT     || 'sender';         // cine plateste transportul

// ---- Token cache (valabil 24h, il reinnoim dupa ~23h) ----
let cachedToken = null;
let tokenExpiresAt = 0;

async function getToken() {
    if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;
    const url = `${BASE}/login?username=${encodeURIComponent(USERNAME)}&password=${encodeURIComponent(PASSWORD)}`;
    const res = await fetch(url, { method: 'POST' });
    const data = await res.json();
    const token = (data && data.data && data.data.token) || data.token;
    if (!token) throw new Error('FanCourier login a esuat: ' + JSON.stringify(data));
    cachedToken = token;
    tokenExpiresAt = Date.now() + 23 * 60 * 60 * 1000;
    return token;
}

function stripDiacritics(s) {
    return (s || '')
        .replace(/[șşȘŞ]/g, 's').replace(/[țţȚŢ]/g, 't')
        .normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * Creeaza un AWB intern FanCourier.
 * @param {object} p
 * @param {object} p.address   - { city, county, addressLine, zipCode }
 * @param {object} p.contact   - { name, phone, email }
 * @param {number} p.weightKg
 * @param {number} p.parcels   - numar colete
 * @param {number} p.cod       - suma ramburs (0 daca e platita online)
 * @param {string} p.reference - ex. "Comanda #10364"
 * @returns {Promise<{awb: string, courier: 'fancourier'}>}
 */
async function createAwb(p) {
    const token = await getToken();

    const shipment = {
        info: {
            service: p.cod > 0 ? SERVICE_COD : SERVICE,
            packages: { parcel: p.parcels || 1, envelope: 0 },
            weight: p.weightKg,
            cod: p.cod || 0,
            declaredValue: 0,
            payment: PAYMENT,
            observation: '',
            content: p.reference,
            dimensions: { length: 20, height: 15, width: 25 } // dimensiuni implicite, cm
        },
        recipient: {
            name: p.contact.name,
            contactPerson: p.contact.name,
            phone: p.contact.phone,
            email: p.contact.email || '',
            address: {
                county:   stripDiacritics(p.address.county) || 'Bucuresti',
                locality: stripDiacritics(p.address.city)   || 'Bucuresti',
                street:   stripDiacritics(p.address.addressLine),
                streetNo: '',
                zipCode:  p.address.zipCode || ''
            }
        }
    };

    const res = await fetch(`${BASE}/intern-awb`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: Number(CLIENT_ID), shipments: [shipment] })
    });
    const data = await res.json();

    const result = data && data.response && data.response[0];
    if (!result) throw new Error('FanCourier: raspuns neasteptat: ' + JSON.stringify(data));
    if (result.errors) throw new Error('FanCourier: ' + JSON.stringify(result.errors));
    if (!result.awbNumber) throw new Error('FanCourier: AWB lipsa in raspuns: ' + JSON.stringify(result));

    return { awb: String(result.awbNumber), courier: 'fancourier' };
}

/** Returneaza eticheta PDF (Buffer) pentru un AWB. */
async function getLabel(awb) {
    const token = await getToken();
    // pdf=1 e obligatoriu, altfel raspunsul e HTML
    const url = `${BASE}/awb/label?clientId=${encodeURIComponent(CLIENT_ID)}&awbs[]=${encodeURIComponent(awb)}&pdf=1&language=ro`;
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!res.ok) throw new Error('FanCourier label: HTTP ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.slice(0, 4).toString() !== '%PDF') {
        throw new Error('FanCourier label: ' + buf.toString().slice(0, 300));
    }
    return buf;
}

function trackingLink(awb) {
    return `https://www.fancourier.ro/awb-tracking/?xawb=${awb}`;
}

module.exports = { createAwb, getLabel, trackingLink, getToken };
