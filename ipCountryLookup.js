const fs = require('fs');
const path = require('path');
const https = require('https');
const net = require('net');

// db-ip lite, CC-BY-4.0 (attribution required). The previous geo-asn-country
// dataset was removed upstream and started 404ing silently in June 2026.
const SOURCE_BASE = 'https://raw.githubusercontent.com/sapics/ip-location-db/main/dbip-country/';
const DB_FILES = { ipv4: 'dbip-country-ipv4.csv', ipv6: 'dbip-country-ipv6.csv' };

class IPCountryLookup {
  constructor() {
    this.ipv4Ranges = [];
    this.ipv6Ranges = [];
    this.lastUpdate = null;
    this.dbPath = path.join(__dirname, 'cache', 'geoip');
  }

  async initialize() {
    if (!fs.existsSync(this.dbPath)) {
      fs.mkdirSync(this.dbPath, { recursive: true });
    }

    await this.loadDatabase();

    // Covers a missing, truncated or stale database in one go
    if (!this.ipv4Ranges.length || !this.ipv6Ranges.length || this.shouldUpdate()) {
      console.log('GeoIP database missing, unusable or stale. Downloading...');
      await this.updateDatabase();
    }
  }

  async loadDatabase() {
    console.log('Loading GeoIP databases...');

    const ipv4File = path.join(this.dbPath, DB_FILES.ipv4);
    const ipv6File = path.join(this.dbPath, DB_FILES.ipv6);

    if (fs.existsSync(ipv4File)) {
      this.ipv4Ranges = this.parseCSV(fs.readFileSync(ipv4File, 'utf8'), 'ipv4');
      console.log(`Loaded ${this.ipv4Ranges.length} IPv4 ranges`);
    }

    if (fs.existsSync(ipv6File)) {
      this.ipv6Ranges = this.parseCSV(fs.readFileSync(ipv6File, 'utf8'), 'ipv6');
      console.log(`Loaded ${this.ipv6Ranges.length} IPv6 ranges`);
    }

    const statsFile = path.join(this.dbPath, 'update.json');
    if (fs.existsSync(statsFile)) {
      try {
        this.lastUpdate = new Date(JSON.parse(fs.readFileSync(statsFile, 'utf8')).lastUpdate);
      } catch (error) {
        this.lastUpdate = null;  // unreadable stamp just means "update now"
      }
    }
  }

  parseCSV(data, type) {
    const lines = data.trim().split('\n');
    const toNumeric = type === 'ipv4'
      ? (ip) => this.ipToNumber(ip)
      : (ip) => this.ipv6ToBigInt(ip);
    const ranges = [];

    for (const line of lines) {
      const parts = line.split(',');
      if (parts.length >= 3) {
        const start = toNumeric(parts[0].trim());
        const end = toNumeric(parts[1].trim());
        if (start === null || end === null) {
          continue;
        }
        ranges.push({ start, end, country: parts[2].trim() });
      }
    }

    // Both lists are binary-searched, so both must be sorted by start address
    ranges.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));

    return ranges;
  }

  ipToNumber(ip) {
    if (!net.isIPv4(ip)) {
      return null;
    }
    const parts = ip.split('.');
    return ((+parts[0]) * 256 * 256 * 256) +
           ((+parts[1]) * 256 * 256) +
           ((+parts[2]) * 256) +
           (+parts[3]);
  }

  // IPv6 as a single BigInt: comparable and sortable, so the same binary
  // search works for both families.
  ipv6ToBigInt(ip) {
    if (!net.isIPv6(ip)) {
      return null;
    }

    let rest = ip;
    let tail = '';

    // "::ffff:192.0.2.1" and friends: fold the dotted quad into two groups
    const embeddedIPv4 = rest.match(/(\d+\.\d+\.\d+\.\d+)$/);
    if (embeddedIPv4) {
      const num = this.ipToNumber(embeddedIPv4[1]);
      if (num === null) {
        return null;
      }
      rest = rest.slice(0, -embeddedIPv4[1].length);
      tail = `${(num >>> 16).toString(16)}:${(num & 0xffff).toString(16)}`;
      if (rest.endsWith(':') && !rest.endsWith('::')) {
        rest = rest.slice(0, -1);
      }
      rest = rest + (rest.endsWith('::') ? '' : ':') + tail;
    }

    const [head, zeros] = rest.split('::');
    const headGroups = head ? head.split(':') : [];
    const tailGroups = zeros ? zeros.split(':') : [];
    const missing = 8 - headGroups.length - tailGroups.length;
    if (missing < 0 || (zeros === undefined && missing !== 0)) {
      return null;
    }

    const groups = [
      ...headGroups,
      ...new Array(zeros === undefined ? 0 : missing).fill('0'),
      ...tailGroups
    ];

    let value = 0n;
    for (const group of groups) {
      value = (value << 16n) + BigInt(parseInt(group, 16) || 0);
    }
    return value;
  }

  findCountry(ranges, value) {
    let low = 0;
    let high = ranges.length - 1;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const range = ranges[mid];

      if (value < range.start) {
        high = mid - 1;
      } else if (value > range.end) {
        low = mid + 1;
      } else {
        return range.country;
      }
    }

    return null;
  }

  lookupCountry(ip) {
    if (!ip || ip === 'unknown') {
      return null;
    }

    // Check if database is loaded
    if (this.ipv4Ranges.length === 0 && this.ipv6Ranges.length === 0) {
      console.log('Warning: GeoIP database not loaded yet');
      return null;
    }

    // Remove IPv6 prefix
    ip = ip.replace(/^::ffff:/, '');

    if (net.isIPv4(ip)) {
      return this.findCountry(this.ipv4Ranges, this.ipToNumber(ip));
    }

    if (net.isIPv6(ip)) {
      const value = this.ipv6ToBigInt(ip);
      return value === null ? null : this.findCountry(this.ipv6Ranges, value);
    }

    return null;
  }

  async updateDatabase() {
    console.log('Updating GeoIP database...');

    await this.downloadFile(SOURCE_BASE + DB_FILES.ipv4, path.join(this.dbPath, DB_FILES.ipv4));
    await this.downloadFile(SOURCE_BASE + DB_FILES.ipv6, path.join(this.dbPath, DB_FILES.ipv6));

    await this.loadDatabase();

    if (!this.ipv4Ranges.length || !this.ipv6Ranges.length) {
      throw new Error(
        `GeoIP download produced an unusable database ` +
        `(${this.ipv4Ranges.length} IPv4 and ${this.ipv6Ranges.length} IPv6 ranges) from ${SOURCE_BASE}`
      );
    }

    fs.writeFileSync(
      path.join(this.dbPath, 'update.json'),
      JSON.stringify({
        lastUpdate: new Date().toISOString(),
        ipv4Count: this.ipv4Ranges.length,
        ipv6Count: this.ipv6Ranges.length
      }, null, 2)
    );

    console.log(
      `GeoIP database updated successfully ` +
      `(${this.ipv4Ranges.length} IPv4, ${this.ipv6Ranges.length} IPv6 ranges)`
    );
  }

  // Downloads via a temp file so a failed fetch cannot destroy a working
  // database, and rejects on anything other than a 200 — a 404 body used to be
  // written straight into the CSV, silently emptying the lookup tables.
  downloadFile(url, dest, redirectsLeft = 3) {
    const tmp = `${dest}.tmp`;

    return new Promise((resolve, reject) => {
      const fail = (error) => {
        fs.unlink(tmp, () => reject(error));
      };

      const request = https.get(url, (response) => {
        const { statusCode, headers } = response;

        if (statusCode >= 300 && statusCode < 400 && headers.location) {
          response.resume();
          if (redirectsLeft <= 0) {
            reject(new Error(`Too many redirects for ${url}`));
            return;
          }
          this.downloadFile(new URL(headers.location, url).toString(), dest, redirectsLeft - 1)
            .then(resolve, reject);
          return;
        }

        if (statusCode !== 200) {
          response.resume();
          reject(new Error(`Download of ${url} failed with HTTP ${statusCode}`));
          return;
        }

        const file = fs.createWriteStream(tmp);
        response.pipe(file);
        response.on('error', fail);
        file.on('error', fail);
        file.on('finish', () => {
          file.close((error) => {
            if (error) {
              fail(error);
              return;
            }
            try {
              fs.renameSync(tmp, dest);
              resolve();
            } catch (renameError) {
              fail(renameError);
            }
          });
        });
      });

      request.on('error', fail);
      request.setTimeout(120000, () => request.destroy(new Error(`Download of ${url} timed out`)));
    });
  }

  shouldUpdate() {
    if (!this.lastUpdate) {
      return true;
    }

    const daysSinceUpdate = (new Date() - this.lastUpdate) / (1000 * 60 * 60 * 24);
    return daysSinceUpdate >= 7;
  }
}

module.exports = IPCountryLookup;

// node ipCountryLookup.js --selftest
if (require.main === module && process.argv.includes('--selftest')) {
  const assert = require('assert');
  const db = new IPCountryLookup();

  db.ipv4Ranges = db.parseCSV(
    '51.174.0.0,51.175.255.255,NO\n1.0.0.0,1.0.0.255,AU\n8.8.8.0,8.8.8.255,US\n',
    'ipv4'
  );
  db.ipv6Ranges = db.parseCSV(
    '2a01:79c::,2a01:79f:ffff:ffff:ffff:ffff:ffff:ffff,NO\n2000::,2000:ffff:ffff:ffff:ffff:ffff:ffff:ffff,CH\n',
    'ipv6'
  );

  assert.strictEqual(db.lookupCountry('51.174.5.9'), 'NO');
  assert.strictEqual(db.lookupCountry('8.8.8.8'), 'US');
  assert.strictEqual(db.lookupCountry('1.0.0.1'), 'AU');
  assert.strictEqual(db.lookupCountry('9.9.9.9'), null);

  // IPv6 in every notation a proxy might hand us
  assert.strictEqual(db.lookupCountry('2a01:79d:1234::1'), 'NO');
  assert.strictEqual(db.lookupCountry('2a01:079d:0000:0000:0000:0000:0000:0001'), 'NO');
  assert.strictEqual(db.lookupCountry('2000::1'), 'CH');
  assert.strictEqual(db.lookupCountry('2a02::1'), null);
  assert.strictEqual(db.lookupCountry('::ffff:51.174.5.9'), 'NO');  // IPv4-mapped

  // Ranges must be sorted for the binary search, whatever order the CSV had
  assert.ok(db.ipv4Ranges.every((r, i, a) => i === 0 || a[i - 1].start <= r.start));
  assert.ok(db.ipv6Ranges.every((r, i, a) => i === 0 || a[i - 1].start <= r.start));

  // A 404 body written into the CSV must yield zero ranges, not garbage ones
  assert.strictEqual(db.parseCSV('404: Not Found', 'ipv4').length, 0);
  assert.strictEqual(db.parseCSV('404: Not Found', 'ipv6').length, 0);

  console.log('ipCountryLookup selftest passed');
}