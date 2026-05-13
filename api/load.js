// api/load.js
// Fetches all produce records from Airtable and returns them to the app

const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE  = process.env.AIRTABLE_BASE;
const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE;

export default async function handler(req, res) {
  // Only allow GET
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth check
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.APP_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}?fields[]=Name&fields[]=Category&fields[]=Status&fields[]=Photo&fields[]=Featured&fields[]=Description&fields[]=Webflow ID`;

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${AIRTABLE_TOKEN}`,
      },
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Airtable fetch failed: ${err}`);
    }

    const data = await response.json();

    // Map Airtable display values back to app slug format
    function toStatusSlug(s) {
      if (s === 'In Season')     return 'in-season';
      if (s === 'Out of Season') return 'out-of-season';
      if (s === 'Coming Soon')   return 'coming-soon';
      return null;
    }

    // Map Airtable records to the format the app expects
    const items = data.records.map(record => ({
      id:          record.id,
      airtableId:  record.id,
      webflowId:   record.fields['Webflow ID'] || null,
      name:        record.fields['Name'] || '',
      category:    record.fields['Category'] || '',
      status:      toStatusSlug(record.fields['Status'] || ''),
      img:         record.fields['Photo'] || null,
      featured:    record.fields['Featured'] || false,
      description: record.fields['Description'] || '',
      editing:     false,
      deleted:     false,
    }));

    return res.status(200).json({ items });

  } catch (err) {
    console.error('Load error:', err);
    return res.status(500).json({ error: err.message });
  }
}
