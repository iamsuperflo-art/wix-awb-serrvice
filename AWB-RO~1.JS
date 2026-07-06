// awb-router.js
// Router Express pentru generarea AWB-urilor din comenzi Wix.
// Montare in index.js:
//   const awbRouter = require('./awb-router');
//   app.use(express.json({ limit: '2mb' }));   // comenzile Wix sunt mari
//   app.use(awbRouter);

const express = require('express');
const fancourier = require('./couriers/fancourier');
const dpd = require('./couriers/dpd');

const router = express.Router();
const SECRET = process.env.RAILWAY_WEBHOOK_SECRET;

const couriers = { fancourier, dpd };

function checkSecret(req, res) {
    const got = req.get('X-Webhook-Secret') || req.query.secret;
    if (!SECRET || got !== SECRET) {
        res.status(401).json({ error: 'unauthorized' });
        return false;
    }
    return true;
}

/** Extrage datele necesare AWB-ului dintr-o comanda Wix eCom. */
function extractShipmentData(order) {
    const ri = order.recipientInfo || {};
    const addr = ri.address || {};
    const cd = ri.contactDetails || {};

    if (!addr.city || !addr.addressLine) throw new Error('Adresa incompleta pe comanda #' + order.number);
    if (!cd.phone) throw new Error('Telefon lipsa pe comanda #' + order.number);

    return {
        address: {
            city: addr.city,
            county: addr.subdivisionFullname || '',   // ex. "Mures"; pt. Bucuresti: "Bucuresti"
            subdivision: addr.subdivision || '',      // ex. "RO-B", "RO-MS"
            addressLine: addr.addressLine,
            zipCode: addr.postalCode || ''
        },
        contact: {
            name: `${cd.firstName || ''} ${cd.lastName || ''}`.trim(),
            phone: cd.phone,
            email: (order.buyerInfo && order.buyerInfo.email) || ''
        },
        reference: `Comanda #${order.number}`
    };
}

/** Regula de rutare: Bucuresti (RO-B) -> FanCourier, restul tarii -> DPD. */
function pickCourier(subdivision) {
    return subdivision === 'RO-B' ? 'fancourier' : 'dpd';
}

// POST /awb  { order, weightKg, parcels, cod }
// - order:    obiectul comenzii Wix (trimis din Velo)
// - weightKg: greutatea introdusa in dashboard
// - parcels:  numar colete (implicit 1)
// - cod:      suma ramburs; 0 pentru comenzi platite online
router.post('/awb', async (req, res) => {
    if (!checkSecret(req, res)) return;
    try {
        const { order, weightKg, parcels, cod } = req.body;
        if (!order || !order.number) return res.status(400).json({ error: 'order lipsa' });
        if (!weightKg || weightKg <= 0) return res.status(400).json({ error: 'weightKg invalid' });

        const data = extractShipmentData(order);
        const courierName = pickCourier(data.address.subdivision);
        const courier = couriers[courierName];

        const result = await courier.createAwb({
            ...data,
            weightKg: Number(weightKg),
            parcels: Number(parcels) || 1,
            cod: Number(cod) || 0
        });

        console.log(`AWB generat: ${result.awb} (${courierName}) pentru comanda #${order.number}`);
        res.json({
            awb: result.awb,
            courier: courierName,
            trackingLink: courier.trackingLink(result.awb)
        });
    } catch (e) {
        console.error('Eroare AWB:', e.message);
        res.status(422).json({ error: e.message });
    }
});

// GET /awb/label/:courier/:awb?secret=...  -> PDF-ul etichetei (pentru butonul "Printeaza" din dashboard)
router.get('/awb/label/:courier/:awb', async (req, res) => {
    if (!checkSecret(req, res)) return;
    try {
        const courier = couriers[req.params.courier];
        if (!courier) return res.status(400).json({ error: 'curier necunoscut' });
        const pdf = await courier.getLabel(req.params.awb);
        res.set('Content-Type', 'application/pdf');
        res.set('Content-Disposition', `inline; filename="awb-${req.params.awb}.pdf"`);
        res.send(pdf);
    } catch (e) {
        console.error('Eroare eticheta:', e.message);
        res.status(422).json({ error: e.message });
    }
});

module.exports = router;
