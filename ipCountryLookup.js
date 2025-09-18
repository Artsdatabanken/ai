const fs = require('fs');
const path = require('path');
const https = require('https');
const net = require('net');

class IPCountryLookup {
  constructor() {
    this.ipv4Ranges = [];
    this.ipv6Ranges = [];
    this.lastUpdate = null;
    this.dbPath = path.join(__dirname, 'geoip');
  }

  async initialize() {
    if (!fs.existsSync(this.dbPath)) {
      fs.mkdirSync(this.dbPath, { recursive: true });
    }

    const ipv4File = path.join(this.dbPath, 'geo-asn-country-ipv4.csv');
    const ipv6File = path.join(this.dbPath, 'geo-asn-country-ipv6.csv');

    if (!fs.existsSync(ipv4File) || !fs.existsSync(ipv6File)) {
      console.log('GeoIP database files not found. Downloading...');
      await this.updateDatabase();
    } else {
      await this.loadDatabase();
    }
  }

  async loadDatabase() {
    try {
      console.log('Loading GeoIP databases...');

      const ipv4File = path.join(this.dbPath, 'geo-asn-country-ipv4.csv');
      const ipv6File = path.join(this.dbPath, 'geo-asn-country-ipv6.csv');

      if (fs.existsSync(ipv4File)) {
        const ipv4Data = fs.readFileSync(ipv4File, 'utf8');
        this.ipv4Ranges = this.parseCSV(ipv4Data, 'ipv4');
        console.log(`Loaded ${this.ipv4Ranges.length} IPv4 ranges`);
      }

      if (fs.existsSync(ipv6File)) {
        const ipv6Data = fs.readFileSync(ipv6File, 'utf8');
        this.ipv6Ranges = this.parseCSV(ipv6Data, 'ipv6');
        console.log(`Loaded ${this.ipv6Ranges.length} IPv6 ranges`);
      }

      const statsFile = path.join(this.dbPath, 'update.json');
      if (fs.existsSync(statsFile)) {
        const stats = JSON.parse(fs.readFileSync(statsFile, 'utf8'));
        this.lastUpdate = new Date(stats.lastUpdate);
      }
    } catch (error) {
      console.error('Error loading GeoIP database:', error);
    }
  }

  parseCSV(data, type) {
    const lines = data.trim().split('\n');
    const ranges = [];

    for (const line of lines) {
      const parts = line.split(',');
      if (parts.length >= 3) {
        if (type === 'ipv4') {
          ranges.push({
            start: this.ipToNumber(parts[0]),
            end: this.ipToNumber(parts[1]),
            country: parts[2].trim()  // Trim whitespace from country code
          });
        } else {
          ranges.push({
            start: parts[0],
            end: parts[1],
            country: parts[2].trim()  // Trim whitespace from country code
          });
        }
      }
    }

    // Sort IPv4 ranges by start IP for binary search to work correctly
    if (type === 'ipv4') {
      ranges.sort((a, b) => a.start - b.start);
    }

    return ranges;
  }

  ipToNumber(ip) {
    const parts = ip.split('.');
    return ((+parts[0]) * 256 * 256 * 256) +
           ((+parts[1]) * 256 * 256) +
           ((+parts[2]) * 256) +
           (+parts[3]);
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

    // Trim whitespace and remove IPv6 prefix
    ip = ip.trim().replace(/^::ffff:/, '');

    if (net.isIPv4(ip)) {
      const ipNum = this.ipToNumber(ip);

      // Binary search to find the range containing this IP
      let low = 0;
      let high = this.ipv4Ranges.length - 1;

      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const range = this.ipv4Ranges[mid];

        if (ipNum < range.start) {
          // IP is before this range
          high = mid - 1;
        } else if (ipNum > range.end) {
          // IP is after this range
          low = mid + 1;
        } else {
          // IP is within this range
          return range.country;
        }
      }
    } else if (net.isIPv6(ip)) {
      const normalizedIp = this.normalizeIPv6(ip);

      for (const range of this.ipv6Ranges) {
        if (this.compareIPv6(normalizedIp, range.start) >= 0 &&
            this.compareIPv6(normalizedIp, range.end) <= 0) {
          return range.country;
        }
      }
    }

    return null;
  }

  normalizeIPv6(ip) {
    const parts = ip.split(':');
    const expandedParts = [];

    let foundEmpty = false;
    for (const part of parts) {
      if (part === '' && !foundEmpty) {
        const missingParts = 8 - parts.filter(p => p !== '').length;
        for (let i = 0; i < missingParts; i++) {
          expandedParts.push('0000');
        }
        foundEmpty = true;
      } else if (part !== '') {
        expandedParts.push(part.padStart(4, '0'));
      }
    }

    return expandedParts.join(':');
  }

  compareIPv6(ip1, ip2) {
    const parts1 = ip1.split(':');
    const parts2 = ip2.split(':');

    for (let i = 0; i < 8; i++) {
      const num1 = parseInt(parts1[i] || '0', 16);
      const num2 = parseInt(parts2[i] || '0', 16);

      if (num1 !== num2) {
        return num1 - num2;
      }
    }

    return 0;
  }

  async updateDatabase() {
    console.log('Updating GeoIP database...');

    try {
      await this.downloadFile(
        'https://raw.githubusercontent.com/sapics/ip-location-db/main/geo-asn-country/geo-asn-country-ipv4.csv',
        path.join(this.dbPath, 'geo-asn-country-ipv4.csv')
      );

      await this.downloadFile(
        'https://raw.githubusercontent.com/sapics/ip-location-db/main/geo-asn-country/geo-asn-country-ipv6.csv',
        path.join(this.dbPath, 'geo-asn-country-ipv6.csv')
      );

      const updateInfo = {
        lastUpdate: new Date().toISOString(),
        ipv4Count: this.ipv4Ranges.length,
        ipv6Count: this.ipv6Ranges.length
      };

      fs.writeFileSync(
        path.join(this.dbPath, 'update.json'),
        JSON.stringify(updateInfo, null, 2)
      );

      await this.loadDatabase();
      console.log('GeoIP database updated successfully');
    } catch (error) {
      console.error('Error updating GeoIP database:', error);
    }
  }

  downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(dest);

      https.get(url, (response) => {
        response.pipe(file);

        file.on('finish', () => {
          file.close();
          resolve();
        });
      }).on('error', (error) => {
        fs.unlink(dest, () => {});
        reject(error);
      });
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