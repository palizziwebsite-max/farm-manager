// api/publish.js
// Serverless function that syncs produce data to Airtable and Webflow

const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE  = process.env.AIRTABLE_BASE;
const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE;
const WEBFLOW_TOKEN  = process.env.WEBFLOW_TOKEN;
const WEBFLOW_COLLECTION = process.env.WEBFLOW_COLLECTION;

// ─── Airtable helpers ────────────────────────────────────────────────────────

async function airtableRequest(method, path, body) {
  const res = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${AIRTABLE_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Airtable ${method} ${path} failed: ${err}`);
  }
  return res.json();
}

async function getAllAirtableRecords() {
  const data = await airtableRequest('GET', `${AIRTABLE_TABLE}?fields[]=Name&fields[]=Category&fields[]=Status&fields[]=Photo&fields[]=Featured&fields[]=Description&fields[]=WebflowID`);
  return data.records; // [{ id, fields }]
}

async function createAirtableRecord(fields) {
  const data = await airtableRequest('POST', AIRTABLE_TABLE, {
    records: [{ fields }],
  });
  return data.records[0]; // { id, fields }
}

async function updateAirtableRecord(recordId, fields) {
  await airtableRequest('PATCH', `${AIRTABLE_TABLE}/${recordId}`, {
    fields,
  });
}

async function deleteAirtableRecord(recordId) {
  await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}/${recordId}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}` },
  });
}

// ─── Webflow helpers ──────────────────────────────────────────────────────────

async function webflowRequest(method, path, body) {
  const res = await fetch(`https://api.webflow.com/v2${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${WEBFLOW_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Webflow ${method} ${path} failed: ${err}`);
  }
  return res.json();
}

function buildWebflowFields(item) {
  return {
    name: item.name,
    slug: item.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''),
    category: item.category || '',
    status: item.status || '',
    photo: item.img ? { url: item.img } : undefined,
    featured: item.featured || false,
    description: item.description || '',
    'airtable-id': item.airtableId || '',
  };
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

async function publishWebflowCollection() {
  await webflowRequest('POST', `/collections/${WEBFLOW_COLLECTION}/items/publish`, {
    itemIds: [],
  });
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Basic auth check via a shared secret
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.APP_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { items } = req.body;
    if (!Array.isArray(items)) {
      return res.status(400).json({ error: 'items array required' });
    }

    // Get all existing Airtable records so we can diff
    const existingRecords = await getAllAirtableRecords();

    const results = [];

    for (const item of items) {
      // Find matching Airtable record by airtableId if it exists
      const existing = item.airtableId
        ? existingRecords.find(r => r.id === item.airtableId)
        : null;

      const airtableFields = {
        Name: item.name,
        Category: item.category || '',
        Status: item.status || '',
        Photo: item.img || '',
        Featured: item.featured || false,
        Description: item.description || '',
      };

      let airtableId = item.airtableId;
      let webflowId  = item.webflowId;

      if (existing) {
        // ── UPDATE existing record ──
        await updateAirtableRecord(airtableId, airtableFields);

        if (webflowId) {
          await updateWebflowItem(webflowId, { ...item, airtableId });
        } else {
          // Webflow item doesn't exist yet — create it
          webflowId = await createWebflowItem({ ...item, airtableId });
          await updateAirtableRecord(airtableId, { WebflowID: webflowId });
        }
      } else {
        // ── CREATE new record ──
        const newRecord = await createAirtableRecord(airtableFields);
        airtableId = newRecord.id;

        webflowId = await createWebflowItem({ ...item, airtableId });

        // Store Webflow ID back in Airtable
        await updateAirtableRecord(airtableId, { WebflowID: webflowId });
      }

      results.push({ localId: item.id, airtableId, webflowId });
    }

    // Handle deletions — items in Airtable that weren't in the publish payload
    const publishedAirtableIds = results.map(r => r.airtableId);
    for (const record of existingRecords) {
      if (!publishedAirtableIds.includes(record.id)) {
        const webflowId = record.fields['WebflowID'];
        if (webflowId) await deleteWebflowItem(webflowId);
        await deleteAirtableRecord(record.id);
      }
    }

    // Publish all changes live on Webflow
    await publishWebflowCollection();

    return res.status(200).json({ success: true, results });

  } catch (err) {
    console.error('Publish error:', err);
    return res.status(500).json({ error: err.message });
  }
}
