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

// Nume judete dupa codul ISO (fara diacritice, pt. nomenclatoarele curierilor)
const JUDETE = {
    'RO-AB':'Alba','RO-AR':'Arad','RO-AG':'Arges','RO-BC':'Bacau','RO-BH':'Bihor',
    'RO-BN':'Bistrita-Nasaud','RO-BT':'Botosani','RO-BV':'Brasov','RO-BR':'Braila',
    'RO-B':'Bucuresti','RO-BZ':'Buzau','RO-CS':'Caras-Severin','RO-CL':'Calarasi',
    'RO-CJ':'Cluj','RO-CT':'Constanta','RO-CV':'Covasna','RO-DB':'Dambovita',
    'RO-DJ':'Dolj','RO-GL':'Galati','RO-GR':'Giurgiu','RO-GJ':'Gorj','RO-HR':'Harghita',
    'RO-HD':'Hunedoara','RO-IL':'Ialomita','RO-IS':'Iasi','RO-IF':'Ilfov',
    'RO-MM':'Maramures','RO-MH':'Mehedinti','RO-MS':'Mures','RO-NT':'Neamt',
    'RO-OT':'Olt','RO-PH':'Prahova','RO-SM':'Satu Mare','RO-SJ':'Salaj','RO-SB':'Sibiu',
    'RO-SV':'Suceava','RO-TR':'Teleorman','RO-TM':'Timis','RO-TL':'Tulcea',
    'RO-VS':'Vaslui','RO-VL':'Valcea','RO-VN':'Vrancea'
};

// Velo/SDK si REST folosesc nume diferite pentru aceleasi campuri de adresa
function pickAddressLine(a) {
    if (!a) return '';
    if (a.addressLine) return a.addressLine;
    if (a.addressLine1) return a.addressLine1 + (a.addressLine2 ? ', ' + a.addressLine2 : '');
    if (a.streetAddress) return `${a.streetAddress.name || ''} ${a.streetAddress.number || ''}`.trim();
    return '';
}

/** Extrage datele necesare AWB-ului dintr-o comanda Wix eCom.
 *  Prefera shippingDestination (reflecta editarile din dashboardul Wix);
 *  recipientInfo ramane snapshot-ul de la plasarea comenzii. */
function extractShipmentData(order) {
    const dest = order.shippingInfo && order.shippingInfo.logistics && order.shippingInfo.logistics.shippingDestination;
    const ri = order.recipientInfo || {};
    const addr = (dest && dest.address) || ri.address || {};
    const cd = (dest && dest.contactDetails) || ri.contactDetails || {};
    const addressLine = pickAddressLine(addr);

    if (!addr.city || !addressLine) throw new Error('Adresa incompleta pe comanda #' + order.number);
    if (!cd.phone) throw new Error('Telefon lipsa pe comanda #' + order.number);

    return {
        address: {
            city: addr.city,
            county: addr.subdivisionFullname || JUDETE[addr.subdivision] || '',
            subdivision: addr.subdivision || '',      // ex. "RO-B", "RO-MS"
            addressLine: addressLine,
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
        // curierul ales manual in dashboard are prioritate; altfel, rutare dupa judet
        const override = (req.body.courier || '').toLowerCase();
        const courierName = couriers[override] ? override : pickCourier(data.address.subdivision);
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
            trackingLink: courier.trackingLink(result.awb),
            warning: result.warning || ''
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

// GET /fancourier/branches?secret=...
// Ruta ajutatoare (o singura data): afiseaza punctele de pe contul FanCourier,
// ca sa afli clientId-ul ("id" din raspuns). Necesita doar FANCOURIER_USERNAME/PASSWORD setate.
router.get('/fancourier/branches', async (req, res) => {
    if (!checkSecret(req, res)) return;
    try {
        const token = await fancourier.getToken();
        const r = await fetch('https://api.fancourier.ro/reports/branches', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        res.json(await r.json());
    } catch (e) {
        res.status(422).json({ error: e.message });
    }
});

module.exports = router;
