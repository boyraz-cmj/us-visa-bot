#!/usr/bin/env node

import fetch from "node-fetch";
import cheerio from 'cheerio';
import qs from 'qs';
import config from './config.js';
import fs from 'fs/promises';

const EMAIL = config.email
const PASSWORD = config.password
const SCHEDULE_ID = config.scheduleId
const PREFERED_FACILITY_ID = config.preferedFacilityId
const LOCALE = config.locale

const BASE_URI = `https://ais.usvisa-info.com/${LOCALE}/niv`
const APPOINTMENT_URI = `${BASE_URI}/schedule/${SCHEDULE_ID}/appointment`

// const DATE_URL = `${BASE_URI}/schedule/${SCHEDULE_ID}/appointment/days/${PREFERED_FACILITY_ID}.json?appointments[expedite]=false`
// const TIME_URL = `${BASE_URI}/schedule/${SCHEDULE_ID}/appointment/times/${PREFERED_FACILITY_ID}.json?date=%s&appointments[expedite]=false`
// const APPOINTMENT_URL = '${BASE_URI}/schedule/{SCHEDULE_ID}/appointment'

let sessionHeaders = null
let facilities = null

// Add function to generate random delay between 11 seconds and 5 minutes
function getRandomDelay() {
  const minDelay = 11;  // 11 seconds
  const maxDelay = 300; // 5 minutes
  return Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
}

// Config güncelleme fonksiyonu
async function updateConfigDate(newDate) {
    try {
        const configPath = new URL('./config.js', import.meta.url);
        const configContent = await fs.readFile(configPath, 'utf-8');
        
        // Mevcut config içeriğini parse et
        const configRegex = /export default\s*({[\s\S]*})/;
        const match = configContent.match(configRegex);
        if (!match) throw new Error('Config format error');
        
        const config = eval('(' + match[1] + ')');
        config.currentDate = newDate;

        // Yeni config içeriğini oluştur
        const newContent = `export default ${JSON.stringify(config, null, 4)}`;
        
        await fs.writeFile(configPath, newContent, 'utf-8');
        log(`Config updated with new date: ${newDate}`);
    } catch (err) {
        log(`Error updating config: ${err.message}`);
    }
}

async function main() {
    // Komut satırı argümanı yerine config'den tarihi al
    let currentConsularDate = config.currentDate;
    let currentAscDate = null;

    if (!currentConsularDate) {
        log(`Invalid current consular date: ${currentConsularDate}`)
        process.exit(1)
    }

    log(`Initializing with current consular date ${currentConsularDate} and asc date ${currentAscDate}`)

    try {
        sessionHeaders = await retry(login)
        facilities = await retry(extractFacilities)

        while(true) {
            const { asc: ascFacilities, consular: consularFacilities } = facilities
            const consularDate = await checkAvailableDate(consularFacilities[0])

            if (!consularDate) {
                log("No dates available")
            } else if (consularDate >= currentConsularDate) {
                log(`Nearest date is worse or equal what's already booked (${consularDate} vs ${currentConsularDate})`)
            } else {
                const consularTime = await checkAvailableTime(consularFacilities[0], consularDate)

                let ascDate = ''
                let ascTime = ''
                let params = {
                    consularFacilityId: consularFacilities[0],
                    consularDate,
                    consularTime,
                    ascFacilityId: ascFacilities[0],
                    ascDate,
                    ascTime,
                }

                if (currentAscDate) {
                    const ascParams = {
                        consulate_id: consularFacilities[0],
                        consulate_date: consularDate,
                        consulate_time: consularTime
                    }

                    const bestAscDate = await checkAvailableDate(ascFacilities[0], ascParams)
                    if (!bestAscDate) {
                        log("No asc dates available")
                        continue
                    }

                    ascDate = bestAscDate < currentAscDate ? bestAscDate : currentAscDate
                    ascTime = await checkAvailableTime(ascFacilities[0], ascDate, ascParams)
                    params = Object.assign({}, params, {
                        ascDate,
                        ascTime
                    })
                }

                book(params).then(() => {
                    log(`Booked appointment with ${params}`)
                })

                // Yeni tarih bulunduğunda config'i güncelle
                await updateConfigDate(consularDate);
                currentConsularDate = consularDate
                currentAscDate = ascDate
            }

            const delay = getRandomDelay();
            log(`Waiting ${delay} seconds before next attempt...`);
            await sleep(delay);
        }
    } catch(err) {
        console.error(err)
        log("Trying again in 5 seconds")
        await sleep(5)

        main()
    }
}

async function login() {
  log(`Logging in`)

  const anonymousHeaders = await fetch(`${BASE_URI}/users/sign_in`, {
    headers: {
      "User-Agent": "",
      "Accept": "*/*",
      "Accept-Encoding": "gzip, deflate, br",
      "Connection": "keep-alive",
    },
  })
    .then(handleErrors)
    .then(extractHeaders)

  return fetch(`${BASE_URI}/users/sign_in`, {
    "headers": Object.assign({}, anonymousHeaders, {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    }),
    "method": "POST",
    "body": new URLSearchParams({
      'utf8': '✓',
      'user[email]': EMAIL,
      'user[password]': PASSWORD,
      'policy_confirmed': '1',
      'commit': 'Acessar'
    }),
  })
    .then(handleErrors)
    .then(response => (
      Object.assign({}, anonymousHeaders, {
        'Cookie': extractRelevantCookies(response)
      })
    ))
}

async function extractFacilities() {
  log(`Loading facilities`)

  const response = await loadAppointmentPage()

  const html = await response.text()
  const $ = cheerio.load(html);
  const ascFacilities = parseSelectOptions($, '#appointments_asc_appointment_facility_id')
  const consularFacilities = parseSelectOptions($, '#appointments_consulate_appointment_facility_id')

  return {
    asc: ascFacilities,
    consular: consularFacilities,
  }
}

function checkAvailableDate(facilityId, params = {}) {
  const mergedParams = Object.assign({}, params, {
    appointments: {
      expedite: false
    }
  })

  return jsonRequest(`${APPOINTMENT_URI}/days/${facilityId}.json?` + qs.stringify(mergedParams))
    .then(d => d.length > 0 ? d[0]['date'] : null)
}

function checkAvailableTime(facilityId, date, params = {}) {
  const mergedParams = Object.assign({}, params, {
    date: date,
    appointments: {
      expedite: false
    }
  })

  return jsonRequest(`${APPOINTMENT_URI}/times/${facilityId}.json?` + qs.stringify(mergedParams))
    .then(d => d['business_times'][0] || d['available_times'][0])
}

function jsonRequest(url) {
  return fetch(url, {
    "headers": Object.assign({}, sessionHeaders, {
      "Accept": "application/json",
      "X-Requested-With": "XMLHttpRequest",
    }),
    "cache": "no-store",
  })
    .then(handleErrors)
    .then(response => response.json())
    .then(handleErrorBody)
}

function handleErrors(response) {
  if (!response.ok) {
    throw new Error(`Got response status: ${response.status}`);
  }

  return response
}

function handleErrorBody(response) {
  const errorMessage = response['error']

  if (errorMessage) {
    throw new Error(errorMessage);
  }

  return response
}

async function book({ consularFacilityId, consularDate, consularTime, ascFacilityId, ascDate, ascTime }) {
  const newHeaders = await loadAppointmentPage()
    .then(extractHeaders)

  return fetch(APPOINTMENT_URI, {
    "method": "POST",
    "redirect": "follow",
    "headers": Object.assign({}, newHeaders, {
      'Content-Type': 'application/x-www-form-urlencoded',
    }),
    "body": new URLSearchParams({
      'utf8': '✓',
      'authenticity_token': newHeaders['X-CSRF-Token'],
      'confirmed_limit_message': '1',
      'use_consulate_appointment_capacity': 'true',
      'appointments[consulate_appointment][facility_id]': consularFacilityId,
      'appointments[consulate_appointment][date]': consularDate,
      'appointments[consulate_appointment][time]': consularTime,
      'appointments[asc_appointment][facility_id]': ascFacilityId,
      'appointments[asc_appointment][date]': ascDate,
      'appointments[asc_appointment][time]': ascTime,
    }),
  })
}

function loadAppointmentPage() {
  return fetch(APPOINTMENT_URI, { "headers": sessionHeaders })
    .then(handleErrors)
}

async function extractHeaders(response) {
  const cookies = extractRelevantCookies(response)

  const html = await response.text()
  const $ = cheerio.load(html);
  const csrfToken = $('meta[name="csrf-token"]').attr('content')

  return {
    "Cookie": cookies,
    "X-CSRF-Token": csrfToken,
    "Referer": BASE_URI,
    "Referrer-Policy": "strict-origin-when-cross-origin",
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive'
  }
}

function extractRelevantCookies(res) {
  const parsedCookies = parseCookies(res.headers.get('set-cookie') || '')
  return `_yatri_session=${parsedCookies['_yatri_session']}`
}

function parseCookies(cookies) {
  const parsedCookies = {}

  cookies.split(';').map(c => c.trim()).forEach(c => {
    const [name, value] = c.split('=', 2)
    parsedCookies[name] = value
  })

  return parsedCookies
}

function parseSelectOptions($, selector) {
  return $(selector).find('option').get().map(el => $(el).val().trim()).filter(v => v)
}

function sleep(s) {
  return new Promise((resolve) => {
    setTimeout(resolve, s * 1000);
  });
}

async function retry(fn, retries = 5) {
  try {
    return fn().catch(err => {
      log(`Soft retrying. Error: ${err}`)
      throw err
    })
  } catch(err) {
    if (retries === 0) {
      throw err
    }

    await sleep(60)
    return retry(fn, retries - 1)
  }
}

function log(message) {
  console.log(`[${new Date().toISOString()}]`, message)
}

// Komut satırı argümanlarını kaldır ve doğrudan main'i çağır
main()
