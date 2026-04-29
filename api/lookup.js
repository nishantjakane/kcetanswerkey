// api/lookup.js
const fs = require('fs');
const path = require('path');

export default function handler(req, res) {
  const { cet } = req.query;
  if (!cet) return res.status(400).json({ error: 'CET number required' });

  try {
    // Path to your CSV file
    const filePath = path.join(process.cwd(), 'data', 'final.csv');
    const fileContent = fs.readFileSync(filePath, 'utf8');
    
    const lines = fileContent.trim().split(/\r?\n/);
    const searchKey = cet.toUpperCase();
    
    let result = null;

    // Search for the record
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',').map(c => c.trim());
      if (cols[0].toUpperCase() === searchKey) {
result = {
  phy: cols[1] === '-' ? '-' : (parseFloat(cols[1]) || 0),
  che: cols[2] === '-' ? '-' : (parseFloat(cols[2]) || 0),
  mat: cols[3] === '-' ? '-' : (parseFloat(cols[3]) || 0),
  total: cols[4] === '-' ? '-' : (parseFloat(cols[4]) || 0)
};
        break;
      }
    }

    if (result) {
      res.status(200).json(result);
    } else {
      res.status(404).json({ error: 'Record not found' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Internal Server Error' });
  }
}