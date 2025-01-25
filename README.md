# us-visa-bot
Bot to anticipate the interview date for a US visa.

## How it works

The bot is quite simple. You provide some informations in the config file, and then the bot signs in on your behalf on https://ais.usvisa-info.com/. It checks the nearest dates every few seconds. When it finds a closer date, it automatically books that time for you and updates the config file with the new date.

## Configuration

Create a `config.js` file in the root directory with the following structure:

```javascript
export default {
    email: 'your-email@example.com',
    password: 'your-password',
    scheduleId: 'your-schedule-id',
    preferedFacilityId: facility_id_number,
    locale: 'tr-tr',
    currentDate: '2025-08-11'  // Your current appointment date in YYYY-MM-DD format
}
```

### How to find the configuration values?

- email and password are your credentials to https://ais.usvisa-info.com.
- locale depends on your language, can be found in the URL when trying to reschedule https://ais.usvisa-info.com/{locale}/. 'tr-tr' for Turkey...
- scheduleId can be found in the URL when trying to reschedule manually https://ais.usvisa-info.com/{locale}/niv/schedule/{scheduleId}/continue_actions.
- preferedFacilityId can be found looking at the network calls when trying to reschedule manually, when you get on the page where you can select a new date, you should see a network call similar to https://ais.usvisa-info.com/{locale}/niv/schedule/{scheduleId}/appointment/address/{facilityId}. İstanbul is 124, Ankara is 125. Alternatively you can inspect the Selector on this page and look at the value.
- currentDate should be your current appointment date in YYYY-MM-DD format (e.g., '2025-08-11'). The bot will try to find dates earlier than this one and automatically update this value in the config file when it finds and books a better date.

## Installing

You'll need node 16+ to run the bot. Also, you'll have to install some dependencies:

```sh
brew install node

npm install
npm install node-fetch
npm install qs
```

## Usage

Simply run:
```sh
node index.js
```

The bot will use the date from your config file and automatically update it when it finds and books earlier dates. You don't need to provide the date as a command line argument anymore.

Make sure to create and configure your config.js file before running the bot.
