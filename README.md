# node-egk

A Node.js package for reading the unencrypted data from public health insurance cards from germany (eGK) and austria (e-Card)

## Installation

- Install [Node.js](https://nodejs.org/)
- Install [PCSC Lite](https://pcsclite.apdu.fr/). On Debian/Ubuntu systems this can be done using `apt install libpcsclite1 libpcsclite-dev pcscd`. 
- `npm install egk`

## Supported card readers

This library was written and tested using the [Identiv uTrust 2770 R](https://support.identiv.com/2700r/) but should work with any reader that provides a PC/SC driver.

## Usage

See `example/index.js` for a full example on how to use this module. Basically, you just have to subscribe to a "card was inserted"-event and call `getInsurantData` when it occurs:

```js
const eGKReader = require('egk');
const egk = new eGKReader();

egk.on('card-connect', async (reader, atr) => {    
    try {
        // Note that this library uses promises/async&await for asynchronous operations and does not 
        // provide a callback. 
        const data = await egk.getInsurantData(atr);
        // do stuff
    } catch (err) {
        console.log("Error: ", err);
    }
});
```

This results in a JSON object representing the insurants data:
```json
{
   "cardType":"egk",
   "insurantId":"P123456789",
   "dob":"19881005",
   "firstName":"Max",
   "lastName":"Musterman",
   "sex":"M",
   "street":"Musterstr.",
   "houseNumber":"1",
   "zipCode":"12345",
   "city":"Musterstadt",
   "country": "DE"
}
```

### API

#### Events

Event | Description
------|------------|
reader-connect | Emitted when a smartcard reader is present. Returns the name of the reader. |
reader-disconnect | Emitted when the smartcard reader is removed. Returns the name of the reader. |
card-connect | Emitted when a card is inserted into the reader.  Returns the name of the reader and the atr from the card. |
card-disconnect | Emitted when the card is removed from the reader. Returns the name of the reader. |
error | Emitted when the underlying smartcard library reported an error, for example if an unsupported card was inserted into the reader. Returns an `Error` object. |

#### Functions

Function | Description | Returns |
---------|-------------|---------|
getInsurantData(atr) | Reads the unencrypted insurance data file from a german or austrian health insurance card, depending on the cards ATR response. | A promise resolving with a JSON object or rejecting with an `Error`. |
getInsurantDataDE() | Same as above, but expects a german health insurance card. The ATR value is ignored. | A promise resolving with a JSON object or rejecting with an `Error`. |
getInsurantDataAT() | Same as above, but expects an austrian health insurance card. The ATR value is ignored. | A promise resolving with a JSON object or rejecting with an `Error`. |
dispose() | Removes all resources and event handlers used by the pcsc library. | - |
