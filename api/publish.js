// api/publish.js
const AIRTABLE_TOKEN     = process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE      = process.env.AIRTABLE_BASE;
const AIRTABLE_TABLE     = process.env.AIRTABLE_TABLE;
const WEBFLOW_TOKEN      = process.env.WEBFLOW_TOKEN;
const WEBFLOW_COLLECTION = process.env.WEBFLOW_COLLECTION;

// ─── Airtable helpers ─────────────────────────────────────────────────────────

async function airtableRequest(method, path, body) {
  const res = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${AIRTABLE_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Airtable ${method} ${path} failed: ${text}`);
  return JSON.parse(text);
}

async function getAllAirtableRecords() {
  const data = await airtableRequest('GET',
    `${AIRTABLE_TABLE}?fields[]=Name&fields[]=Category&fields[]=Status&fields[]=Photo&fields[]=Featured&fields[]=Description&fields[]=WebflowID`
  );
  return data.records;
}

async function createAirtableRecord(fields) {
  const data = await airtableRequest('POST', AIRTABLE_TABLE, { records: [{ fields }] });
  return data.records[0];
}

async function updateAirtableRecord(recordId, fields) {
  await airtableRequest('PATCH', `${AIRTABLE_TABLE}/${recordId}`, { fields });
}

async function deleteAirtableRecord(recordId) {
  const res = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}/${recordId}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Airtable DELETE failed: ${text}`);
  }
}

// ─── Webflow helpers ──────────────────────────────────────────────────────────

async function webflowRequest(method, path, body) {
  const res = await fetch(`https://api.webflow.com/v2${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${WEBFLOW_TOKEN}`,
      'Content-Type': 'application/json',
      'accept': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Webflow ${method} ${path} failed: ${text}`);
  return text ? JSON.parse(text) : {};
}

// Map status/category values from app format to Webflow option format
function mapStatus(s) {
  if (s === 'in-season')      return 'In Season';
  if (s === 'out-of-season')  return 'Out of Season';
  if (s === 'coming-soon')    return 'Coming Soon';
  return '';
}

function mapCategory(c) {
  const valid = ['Vegetables', 'Fruit', 'Peppers', 'Other'];
  return valid.includes(c) ? c : '';
}

function buildSlug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function buildWebflowFields(item) {
  const fields = {
    name:          item.name,
    slug:          buildSlug(item.name),
    category:      mapCategory(item.category || ''),
    status:        mapStatus(item.status || ''),
    featured:      item.featured || false,
    description:   item.description || '',
    'airtable-id': item.airtableId || '',
  };

  // Only include photo if there's an actual URL
  if (item.img && item.img.startsWith('http')) {
    fields.photo = { url: item.img };
  }

  return fields;
}

async function createWebflowItem(item) {
  const data = await webflowRequest('POST', `/collections/${WEBFLOW_COLLECTION}/items`, {
    fieldData: buildWebflowFields(item),
    isDraft: false,
  });
  return data.id;
}

async function updateWebflowItem(webflowId, item) {
  await webflowRequest('PATCH', `/collections/${WEBFLOW_COLLECTION}/items/${webflowId}`, {
    fieldData: buildWebflowFields(item),
    isDraft: false,
  });
}

async function deleteWebflowItem(webflowId) {
  await webflowRequest('DELETE', `/collections/${WEBFLOW_COLLECTION}/items/${webflowId}`);
}

async function publishWebflowItems(itemIds) {
  if (itemIds.length === 0) return;
  await webflowRequest('POST', `/collections/${WEBFLOW_COLLECTION}/items/publish`, {
    itemIds,
  });
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.APP_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { items } = req.body;
    if (!Array.isArray(items)) {
      return res.status(400).json({ error: 'items array required' });
    }

    const existingRecords = await getAllAirtableRecords();
    const results = [];
    const webflowIdsToPublish = [];

    for (const item of items) {
      const existing = item.airtableId
        ? existingRecords.find(r => r.id === item.airtableId)
        : null;

      const airtableFields = {
        Name:        item.name,
        Category:    mapCategory(item.category || ''),
        Status:      mapStatus(item.status || ''),
        Photo:       item.img || '',
        Featured:    item.featured || false,
        Description: item.description || '',
      };

      let airtableId = item.airtableId;
      let webflowId  = item.webflowId;

      if (existing) {
        await updateAirtableRecord(airtableId, airtableFields);
        if (webflowId) {
          await updateWebflowItem(webflowId, { ...item, airtableId });
        } else {
          webflowId = await createWebflowItem({ ...item, airtableId });
          await updateAirtableRecord(airtableId, { WebflowID: webflowId });
        }
      } else {
        const newRecord = await createAirtableRecord(airtableFields);
        airtableId = newRecord.id;
        webflowId  = await createWebflowItem({ ...item, airtableId });
        await updateAirtableRecord(airtableId, { WebflowID: webflowId });
      }

      webflowIdsToPublish.push(webflowId);
      results.push({ localId: item.id, airtableId, webflowId });
    }

    // Delete items that were removed
    const publishedAirtableIds = results.map(r => r.airtableId);
    for (const record of existingRecords) {
      if (!publishedAirtableIds.includes(record.id)) {
        const wfId = record.fields['WebflowID'];
        if (wfId) {
          try { await deleteWebflowItem(wfId); } catch(e) { console.warn('Webflow delete failed:', e.message); }
        }
        await deleteAirtableRecord(record.id);
      }
    }

    // Publish all updated items live on Webflow
    await publishWebflowItems(webflowIdsToPublish);

    return res.status(200).json({ success: true, results });

  } catch (err) {
    console.error('Publish error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
