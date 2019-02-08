const net = require('net')
const https = require('https')
const url = require('url')
const validator = require('validator')

const splitStringBy = (string, by) => [string.slice(0, by), string.slice(by + 1)]
const requestGetBody = url => {
	return new Promise((resolve, reject) => {
		https.get(url, (resp) => {
			let data = '';
			resp.on('data', chunk => data += chunk);
			resp.on('end', () => resolve(data));
			resp.on('error', reject);
		}).on('error', reject);
	});
}

// cache
let cacheTldWhoisServer = {}



const whoisQuery = ({host = null, port = 43, timeout = 15000, query = '', querySuffix = "\r\n"} = {}) => {
	return new Promise((resolve, reject) => {
		let data = '';
		const socket = net.connect({host: host, port: port}, () => socket.write(query + querySuffix));
		socket.setTimeout(timeout);
		socket.on('data', chunk => data += chunk);
		socket.on('close', hadError => resolve(data));
		socket.on('timeout', () => socket.destroy(new Error('Timeout')));
		socket.on('error', reject);
	});
}


const allTlds = async () => {
	const tlds = await requestGetBody('https://data.iana.org/TLD/tlds-alpha-by-domain.txt');

	return tlds.split("\n").filter(tld => tld && !tld.startsWith('#'))
}


const whoisTld = async (tld, {timeout = 15000} = {}) => {
	let result;

	try {
		result = await whoisQuery({
			host:		'whois.iana.org',
			query:		tld,
			timeout:	timeout
		});
	} catch (err) {
		throw err
	}

	const data = parseSimpleWhois(result);

	if (!data.domain || !data.domain.length) {
		throw new Error(`TLD "${tld}" not found`)
	}

	return data
}


const whoisDomain = async (domain, {host = null, timeout = 15000, follow = 2} = {}) => {
	const [domainName, domainTld] = splitStringBy(domain.toLowerCase(), domain.lastIndexOf('.'))
	let results = {}

	// find WHOIS server in cache
	if (!host && cacheTldWhoisServer[domainTld]) {
		host = cacheTldWhoisServer[domainTld]
	}

	// find WHOIS server for TLD
	if (!host) {
		try {
			const tld = await whoisTld(domain, {timeout: timeout});

			if (!tld.whois) {
				throw new Error(`TLD for "${domain}" not supported`)
			}

			host = tld.whois
			cacheTldWhoisServer[domainTld] = tld.whois
		} catch (err) {
			throw new Error(`TLD WHOIS error "${err.message}"`)
		}
	}

	while (host && follow) {
		try {
			result = await whoisQuery({
				host:		host,
				query:		domain,
				timeout:	timeout
			});

			result = parseDomainWhois(result);
		} catch (err) {
			result = {
				error:	`WHOIS Error: ${err.message}`
			};
		}

		results[host] = result;
		follow--;

		// check for next WHOIS server
		let nextWhoisServer = result['Registrar WHOIS Server'] || result['ReferralServer'] || result['Registrar Whois'] || result['Whois Server'] || result['WHOIS Server'] || false;

		if (nextWhoisServer) {

			// if found, remove protocol and path
			if (nextWhoisServer.includes('://')) {
				let parsedUrl = url.parse(nextWhoisServer);
				nextWhoisServer = parsedUrl.host
			}

			// hardcoded whois server fixes..
			if (nextWhoisServer === 'www.gandi.net/whois') {
				nextWhoisServer = 'whois.gandi.net';	// whois.nic.link returns incorrect URL for registrar WHOIS
			}

			nextWhoisServer = !results[nextWhoisServer] ? nextWhoisServer : false
		}

		host = nextWhoisServer;
	}

	return results
}


const parseDomainWhois = whois => {
	const shouldBeArray = ['Domain Status', 'Name Server', 'Nameserver', 'Nserver', 'Name servers'];
	const ignoreLabels = ['note', 'notes', 'please note', 'important', 'notice', 'terms of use', 'web-based whois', 'https', 'to', 'registration service provider'];
	const ignoreTexts = ['more information', 'lawful purposes', 'to contact', 'use this data', 'register your domain', 'copy and paste', 'find out more', 'this', 'please', 'important', 'prices', 'payment', 'you agree', 'terms'];

	let text = [];
	let data = {};
	let lines = whois.trim().split('\n').map(line => line.trim());

	// Fix "label: \n value" format
	lines.forEach((line, index) => {
		if (!line.startsWith('%') && line.endsWith(':')) {
			let addedLabel = false;

			for (let i = 1; i <= 5; i++) {
				if (!lines[index + i] || !lines[index + i].length || lines[index + i].includes(': ') || lines[index + i].endsWith(':')) {
					break;
				}

				lines[index + i] = line + ' ' + lines[index + i];
			}

			if (addedLabel) {
				lines[index] = '';
			}
		}
	});

	lines.forEach(line => {

		if ((line.includes(': ') || line.endsWith(':')) && !line.startsWith('%')) {
			const [label, value] = splitStringBy(line, line.indexOf(':')).map(info => info.trim())

			if (shouldBeArray.includes(label)) {
				if (value) {
					data[label] = data[label] || [];
					data[label].push(value);
				}
			} else if (!ignoreLabels.includes(label.toLowerCase()) && !ignoreTexts.some(text => label.toLowerCase().includes(text))) {
				data[label] = data[label] ? data[label] + ' ' + value : value;
			} else {
				text.push(line);
			}
		} else {
			text.push(line);
		}

	});


	// remove multiple empty lines
	text = text.join("\n").trim();
	while (text.includes("\n\n\n")) {
		text = text.replace("\n\n\n", "\n")
	}

	data.text = text.split("\n");

	return data;
}


const whoisIp = async (ip, {host = null, timeout = 15000, follow = 2} = {}) => {
	let data = {}

	// find WHOIS server for IP
	if (!host) {
		try {
			let whoisIp = await whoisQuery({
				host:		'whois.iana.org',
				query:		ip,
				timeout:	timeout
			});

			whoisIp = parseSimpleWhois(whoisIp);

			if (whoisIp.whois) {
				host = whoisIp.whois;
			}

		} catch (err) {
			throw new Error(`IP WHOIS error "${err.message}"`)
		}
	}

	if (!host) {
		throw new Error(`No WHOIS server for "${ip}"`)
	}

	try {
		let query = ip;

		// hardcoded custom queries..
		if (host === 'whois.arin.net') {
			query = `+ n ${query}`;
		}

		let whoisIp = await whoisQuery({
			host:		host,
			query:		query,
			timeout:	timeout
		});

		//data = parseSimpleWhois(whoisIp);
		data = whoisIp.split("\n");

	} catch (err) {
		throw new Error(`IP WHOIS error "${err.message}"`)
	}

	return data
}


const parseSimpleWhois = whois => {
	let data = {}

	if (whois.includes('returned 0 objects')) {
		return data;
	}

	const groups = whois.split("\n\n").map(group => {
		let lines = group.split("\n").filter(line => line && !line.startsWith('%'));
		let type = false;
		let contactType = false;

		lines.forEach(line => {
			const [label, value] = splitStringBy(line, line.indexOf(':')).map(info => info.trim())

			if (!type) {
				type = ['organisation', 'contact'].includes(label) ? label : 'line';
			}

			if (type === 'contact') {
				if (!data.contact) {
					data.contact = {};
				}

				if (label === 'contact') {
					contactType = value;
					data.contact[contactType] = {};
				} else {
					if (data.contact[contactType][label]) {
						data.contact[contactType][label] += "\n" + value;
					} else {
						data.contact[contactType][label] = value;
					}
				}
			} else if (type === 'organisation') {
				if (!data.organisation) {
					data.organisation = {};
				}

				if (data.organisation[label]) {
					data.organisation[label] += "\n" + value;
				} else {
					data.organisation[label] = value;
				}
			} else {
				if (data[label]) {
					if (!Array.isArray(data[label])) {
						data[label] = [data[label]];
					}
					data[label].push(value);
				} else {
					data[label] = value;
				}
			}
		});

		return lines
	});

	return data
}


module.exports = async function(query) {

	if (net.isIP(query)) {
		return whoisIp(query)
	} else if (validator.isFQDN(query)) {
		return whoisDomain(query)
	} else if (validator.isAlpha(query) && query.length > 1 && query.length < 32) {
		return whoisTld(query)
	}

	throw new Error('Unrecognized query. Try a domain (google.com), IP (1.1.1.1) or TLD (blog)')
}

module.exports.query = whoisQuery
module.exports.tld = whoisTld
module.exports.domain = whoisDomain
module.exports.ip = whoisIp
module.exports.allTlds = allTlds