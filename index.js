#!/usr/bin/env node

import fetch from "node-fetch";
import cheerio from 'cheerio';
import qs from 'qs';

const EMAIL = 'foo@bar.com'
const PASSWORD = '*********'
const SCHEDULE_ID = '12345678'
const PREFERED_FACILITY_ID = 125 // Istanbul
// 124 Ankara
const LOCALE = 'tr-tr'
const REFRESH_DELAY = 11

const BASE_URI = `https://ais.usvisa-info.com/${LOCALE}/niv`
const APPOINTMENT_URI = `${BASE_URI}/schedule/${SCHEDULE_ID}/appointment`

// const DATE_URL = `${BASE_URI}/schedule/${SCHEDULE_ID}/appointment/days/${PREFERED_FACILITY_ID}.json?appointments[expedite]=false`
// const TIME_URL = `${BASE_URI}/schedule/${SCHEDULE_ID}/appointment/times/${PREFERED_FACILITY_ID}.json?date=%s&appointments[expedite]=false`
// const APPOINTMENT_URL = '${BASE_URI}/schedule/{SCHEDULE_ID}/appointment'

let sessionHeaders = null
let facilities = null

function getRefreshDelay() {
  let delay =  Math.floor(Math.random() * (15 - 5 + 1)) + 5;
  log(`Will be delayed this time for ${delay} sec.`)
  return delay;
}

async function main(currentConsularDate, currentAscDate) {
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
      let facilityIndexForIstanbul = 1;
      let facilityIndexforAnkara = 0;
      let consularFacility = consularFacilities[facilityIndexForIstanbul];
      let ascFacility = ascFacilities[0];
      const consularDate = await checkAvailableDate(consularFacility)

      if (!consularDate) {
        log("No dates available")
      } else if (consularDate >= currentConsularDate) {
        var city = '';
        if (consularFacility == 125) {
          city = 'İstanbul';
        } else if (consularFacility == 124) {
          city = 'Ankara';
        }

        log(`Nearest date for ${city} is worse or equal what's already booked (${consularDate} vs ${currentConsularDate})`)
      } else {
        const consularTime = await checkAvailableTime(consularFacility, consularDate)

        let ascDate = ''
        let ascTime = ''
        let params = {
          consularFacilityId: consularFacility,
          consularDate,
          consularTime,
          ascFacilityId: ascFacility,
          ascDate,
          ascTime,
        }

        if (currentAscDate) {
          const ascParams = {
            consulate_id: consularFacility,
            consulate_date: consularDate,
            consulate_time: consularTime
          }

          const bestAscDate = await checkAvailableDate(ascFacility, ascParams)
          if (!bestAscDate) {
            log("No asc dates available")
            continue
          }

          ascDate = bestAscDate < currentAscDate ? bestAscDate : currentAscDate
          ascTime = await checkAvailableTime(ascFacility, ascDate, ascParams)
          params = Object.assign({}, params, {
            ascDate,
            ascTime
          })
        }

       retry(book(params), 5, 5)
       .then(() => {
          log(`Booked appointment with ${params}`)
        })

        currentConsularDate = consularDate
        currentAscDate = ascDate
      }

      await sleep(getRefreshDelay())
    }
  } catch(err) {
    console.error(err)
    log("Trying again in 5 seconds")
    await sleep(5)

    main(currentConsularDate, currentAscDate)
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
  .then(handleErrors)
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

async function retry(fn, retries = 5, sleepInterval = 60) {
  try {
    return fn().catch(err => {
      log(`Soft retrying. Error: ${err}`)
      throw err
    })
  } catch(err) {
    if (retries === 0) {
      throw err
    }

    await sleep(sleepInterval)
    return retry(fn, retries - 1)
  }
}

function log(message) {
  console.log(`[${new Date().toISOString()}]`, message)
}

const args = process.argv.slice(2);
const currentConsularDate = args[0]
const currentAscDate = args[1]
main(currentConsularDate, currentAscDate)
