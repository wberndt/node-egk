# node-egk

A Node.js package for reading the unencrypted data from german public health insurance cards ("elektronische Gesundheitskarte", eGK).

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

egk.on('card-connect', async () => {    
    try {
        // Note that this library uses promises/async&await for asynchronous operations and does not 
        // provide a callback. 
        const data = await egk.getInsurantData();
        // do stuff
    } catch (err) {
        console.log("Error: ", err);
    }
});
```

This results in a JSON object representing the insurants data:

```json
{
   "UC_PersoenlicheVersichertendatenXML":{
      "$":{
         "CDM_VERSION":"5.2.0",
         "xmlns:vsdp":"http://ws.gematik.de/fa/vsdm/vsd/v5.2"
      },
      "Versicherter":{
         "Versicherten_ID":"K123456789",
         "Person":{
            "Geburtsdatum":"19760201",
            "Vorname":"Max",
            "Nachname":"Mustermann",
            "Geschlecht":"M",
            "StrassenAdresse":{
               "Postleitzahl":"12345",
               "Ort":"Musterstadt",
               "Land":{
                  "Wohnsitzlaendercode":"D"
               },
               "Strasse":"Musterstr.",
               "Hausnummer":"1"
            }
         }
      }
   }
}
```

### API

#### Events

Event | Description
------|------------|
reader-connect | Emitted when a smartcard reader is present. Returns the name of the reader. |
reader-disconnect | Emitted when the smartcard reader is removed. Returns the name of the reader. |
card-connect | Emitted when a card is inserted into the reader.  Returns the name of the reader. |
card-disconnect | Emitted when the card is removed from the reader. Returns the name of the reader. |
error | Emitted when the underlying smartcard library reported an error, for example if an unsupported card was inserted into the reader. Returns an `Error` object. |

#### Functions

Function | Description | Returns |
---------|-------------|---------|
getInsurantData() | Reads the unencrypted insurant data file from the card and returns the data as JSON object. | A promise resolving with a JSON object or rejecting with an `Error`. |
dispose() | Removes all resources and event handlers used by the pcsc library. | - |
