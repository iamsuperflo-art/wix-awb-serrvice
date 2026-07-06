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
 * Gaseste localitatea in nomenclatorul DPD si returneaza siteId.
 * Incearca intai dupa cod postal (rezolva satele -> comuna corecta),
 * apoi dupa nume. Arunca eroare lizibila daca nu gaseste nimic.
 */
async function findSiteId(city, zipCode) {
    const cityClean = stripDiacritics(city).trim().toUpperCase();

    if (zipCode) {
        const res = await post('location/site/', { countryId: COUNTRY_RO, postCode: zipCode });
        const data = await res.json();
        const sites = data.sites || [];
        if (sites.length === 1) return sites[0].id;
        if (sites.length > 1) {
            const exact = sites.find(s => stripDiacritics(s.name).toUpperCase() === cityClean);
            return (exact || sites[0]).id;
        }
    }

    const res2 = await post('location/site/', { countryId: COUNTRY_RO, name: cityClean });
    const data2 = await res2.json();
    const sites2 = data2.sites || [];
    if (sites2.length === 1) return sites2[0].id;
    if (sites2.length > 1) {
        const exact = sites2.find(s => stripDiacritics(s.name).toUpperCase() === cityClean);
        if (exact) return exact.id;
        throw new Error(`Localitate ambigua "${city}" - candidati DPD: ` +
            sites2.slice(0, 5).map(s => `${s.name} (${s.regionName || s.region || ''})`).join(', ') +
            '. Corecteaza orasul/codul postal in comanda Wix.');
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
    const siteId = await findSiteId(p.address.city, p.address.zipCode);
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

    return { awb: String(data.id), courier: 'dpd' };
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
