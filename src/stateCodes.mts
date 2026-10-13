// Resolve an Indian state to the Salesforce State/Country picklist code (ISO-style, e.g. 'MH').
// Two sources, in priority order: the Tally ledger's state name ($LedStateName), then the GSTIN's
// first two digits ($PartyGSTIN) as a fallback. Used by the inbound account pull to populate
// BillingAddress__StateCode__s so GST intra/inter-state (CGST+SGST vs IGST) can be determined.

// Lowercased, trimmed state name -> SF picklist code. Includes common spelling variants.
const STATE_NAME_TO_CODE: Record<string, string> = {
    'jammu and kashmir': 'JK', 'himachal pradesh': 'HP', 'punjab': 'PB', 'chandigarh': 'CH',
    'uttarakhand': 'UK', 'haryana': 'HR', 'delhi': 'DL', 'rajasthan': 'RJ', 'uttar pradesh': 'UP',
    'bihar': 'BR', 'sikkim': 'SK', 'arunachal pradesh': 'AR', 'nagaland': 'NL', 'manipur': 'MN',
    'mizoram': 'MZ', 'tripura': 'TR', 'meghalaya': 'ML', 'assam': 'AS', 'west bengal': 'WB',
    'jharkhand': 'JH', 'odisha': 'OR', 'orissa': 'OR', 'chhattisgarh': 'CG', 'madhya pradesh': 'MP',
    'gujarat': 'GJ', 'daman and diu': 'DD', 'dadra and nagar haveli': 'DN', 'maharashtra': 'MH',
    'karnataka': 'KA', 'goa': 'GA', 'lakshadweep': 'LD', 'kerala': 'KL', 'tamil nadu': 'TN',
    'puducherry': 'PY', 'pondicherry': 'PY', 'andaman and nicobar islands': 'AN', 'telangana': 'TG',
    'andhra pradesh': 'AP', 'ladakh': 'LA',
};

// GST state code (first 2 digits of a GSTIN) -> SF picklist code.
const GST_NUM_TO_CODE: Record<string, string> = {
    '01': 'JK', '02': 'HP', '03': 'PB', '04': 'CH', '05': 'UK', '06': 'HR', '07': 'DL', '08': 'RJ',
    '09': 'UP', '10': 'BR', '11': 'SK', '12': 'AR', '13': 'NL', '14': 'MN', '15': 'MZ', '16': 'TR',
    '17': 'ML', '18': 'AS', '19': 'WB', '20': 'JH', '21': 'OR', '22': 'CG', '23': 'MP', '24': 'GJ',
    '25': 'DD', '26': 'DN', '27': 'MH', '28': 'AP', '29': 'KA', '30': 'GA', '31': 'LD', '32': 'KL',
    '33': 'TN', '34': 'PY', '35': 'AN', '36': 'TG', '37': 'AP', '38': 'LA',
};

/** Resolve an SF State/Country picklist code (e.g. 'MH') from a Tally state name and/or GSTIN.
 *  Returns '' when neither source resolves. State name wins; GSTIN's leading 2 digits are the
 *  fallback. */
export function resolveStateCode(stateName?: string, gstin?: string): string {
    const name = String(stateName || '').trim().toLowerCase();
    if (name && STATE_NAME_TO_CODE[name]) return STATE_NAME_TO_CODE[name];
    const digits = String(gstin || '').trim().slice(0, 2);
    if (/^\d{2}$/.test(digits) && GST_NUM_TO_CODE[digits]) return GST_NUM_TO_CODE[digits];
    return '';
}
