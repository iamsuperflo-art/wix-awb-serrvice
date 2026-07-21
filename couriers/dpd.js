// couriers/dpd.js
// DPD Romania REST API (api.dpd.ro/v1) — folosit pentru comenzile din afara Bucurestiului
// Docs: https://api.dpd.ro/web-api.html | Exemple: https://services.dpd.ro/api/api_examples.php

const BASE = 'https://api.dpd.ro/v1';

const USERNAME   = process.env.DPD_USERNAME;
const PASSWORD   = process.env.DPD_PASSWORD;
const SERVICE_ID = Number(process.env.DPD_SERVICE_ID || 2505); // 2505 = DPD Classic (Romania). Verifica cu /services pe contractul tau.
const COUNTRY_RO = 642;

function auth(body) {
    return Object.assign({ userName: USERNAME, password: PASSWORD, language: 'RO' }, body);
}

function stripDiacritics(s) {
    return (s || '')
        .replace(/[șşȘŞ]/g, 's').replace(/[țţȚŢ]/g, 't')
        .normalize('NFD').replace(/[̀-ͯ]/g, '');
}

async function post(path, body) {
    const res = await fetch(`${BASE}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(auth(body)),
        signal: AbortSignal.timeout(10000)   // DPD nu raspunde -> eroare lizibila, nu timeout Wix
    }).catch((e) => {
        throw new Error('DPD nu raspunde (' + e.message + '). Verifica userul de API - DPD cere un user dedicat, activat la cerere.');
    });
    return res;
}

/**
 * Gaseste localitatea in nomenclatorul DPD si returneaza { id, warning }.
 * Ordinea: 1) NUMELE localitatii (dezambiguizat prin judet la omonime),
 * 2) codul postal doar ca fallback - clientii gresesc des codul postal,
 * asa ca folosirea lui genereaza un avertisment vizibil in dashboard.
 */
async function findSiteId(city, zipCode, county) {
    const cityClean = stripDiacritics(city).trim().toUpperCase();
    const countyClean = stripDiacritics(county || '').trim().toUpperCase();

    // 1) cautare dupa nume
    const res = await post('location/site/', { countryId: COUNTRY_RO, name: cityClean });
    const data = await res.json();
    const sites = data.sites || [];
    const exact = sites.filter(s => stripDiacritics(s.name || '').toUpperCase() === cityClean);

    if (exact.length === 1) return { id: exact[0].id, warning: '' };
    if (exact.length > 1) {
        // localitati omonime -> dezambiguizare prin judet, apoi prin cod postal
        const byCounty = countyClean
            ? exact.filter(s => stripDiacritics(s.region || s.regionName || '').toUpperCase().includes(countyClean))
            : [];
        if (byCounty.length === 1) return { id: byCounty[0].id, warning: '' };
        const byZip = zipCode ? exact.filter(s => String(s.postCode || '') === String(zipCode)) : [];
        if (byZip.length === 1) return { id: byZip[0].id, warning: '' };
        const pick = byCounty[0] || exact[0];
        return {
            id: pick.id,
            warning: `Localitati multiple cu numele "${city}" - am ales ${pick.name} (${pick.region || pick.regionName || '?'}). VERIFICA!`
        };
    }

    // 2) fallback: cod postal (sate -> comuna corecta; dar un cod gresit duce la ALTA localitate)
    if (zipCode) {
        const res2 = await post('location/site/', { countryId: COUNTRY_RO, postCode: zipCode });
        const data2 = await res2.json();
        const sites2 = data2.sites || [];
        if (sites2.length >= 1) {
            const s = sites2[0];
            return {
                id: s.id,
                warning: `Localitatea "${city}" nu exista la DPD; am folosit codul postal ${zipCode} -> ${s.name} (${s.region || s.regionName || '?'}). VERIFICA inainte de predare!`
            };
        }
    }

    throw new Error(`Localitatea "${city}" (cod postal ${zipCode || '-'}) nu exista in nomenclatorul DPD. ` +
        'Corecteaza orasul in comanda Wix (la sate, foloseste numele comunei).');
}

/**
 * Creeaza o expediere DPD (AWB).
 * @param {object} p - aceleasi campuri ca la fancourier.createAwb
 * @returns {Promise<{awb: string, courier: 'dpd'}>}
 */
async function createAwb(p) {
    const site = await findSiteId(p.address.city, p.address.zipCode, p.address.county);
    const siteId = site.id;
    const body = {
        // sender: omis => se foloseste expeditorul implicit de pe contractul DPD
        recipient: {
            clientName: p.contact.name,
            privatePerson: true,
            phone1: { number: p.contact.phone },
            email: p.contact.email || undefined,
            address: {
                countryId: COUNTRY_RO,
                siteId: siteId,   // localitatea, rezolvata prin nomenclatorul DPD
                // pt. adrese interne, DPD cere strada structurata SAU totul in addressNote
                addressNote: stripDiacritics(p.address.addressLine).slice(0, 200)
            }
        },
        service: {
            serviceId: SERVICE_ID,
            autoAdjustPickupDate: true
        },
        content: {
            parcelsCount: p.parcels || 1,
            contents: p.reference,
            package: 'BOX',
            totalWeight: p.weightKg
        },
        payment: { courierServicePayer: 'SENDER' },
        ref1: p.reference
    };

    if (p.cod > 0) {
        body.service.additionalServices = {
            cod: { amount: p.cod, processingType: 'CASH' }
        };
    }

    const res = await post('shipment/', body);
    const data = await res.json();

    if (data.error) throw new Error('DPD: ' + (data.error.message || JSON.stringify(data.error)));
    if (!data.id) throw new Error('DPD: AWB lipsa in raspuns: ' + JSON.stringify(data));

    return { awb: String(data.id), courier: 'dpd', warning: site.warning || '' };
}

/** Returneaza eticheta PDF (Buffer) pentru un AWB. */
async function getLabel(awb) {
    const res = await post('print/', {
        paperSize: 'A6',
        parcels: [{ parcel: { id: awb } }]
    });
    if (!res.ok) throw new Error('DPD label: HTTP ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    // daca raspunsul e JSON, e o eroare, nu un PDF
    if (buf.slice(0, 4).toString() !== '%PDF') {
        throw new Error('DPD label: ' + buf.toString().slice(0, 300));
    }
    return buf;
}

function trackingLink(awb) {
    return `https://tracking.dpd.ro/?shipmentNumber=${awb}&language=ro`;
}

module.exports = { createAwb, getLabel, trackingLink };
