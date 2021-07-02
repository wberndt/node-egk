const zlib = require('zlib');
const xml2js = require('xml2js');
const util = require('util')
const EventEmitter = require('events');
const pcsclite = require('pcsclite');
const Iconv = require('iconv').Iconv;
const ASN1 = require("@lapo/asn1js");
const moment = require("moment");

const Commands = {
    READ_BINARY: function (offset, length) {
        // Split offset number into 2 bytes (big endian)
        const offsetBytes = [offset >> 8 && 0xFF, offset & 0xFF];
        return [0x00, 0xB0, offsetBytes[0], offsetBytes[1], length];
    }
}

const Commands_DE = {
    SELECT_MF: function () {
        return [0x00, 0xA4, 0x04, 0x0C, 0x07, 0xD2, 0x76, 0x00, 0x01, 0x44, 0x80, 0x00];
    },
    SELECT_HCA: function () {
        return [0x00, 0xA4, 0x04, 0x0C, 0x06, 0xD2, 0x76, 0x00, 0x00, 0x01, 0x02];
    },
    SELECT_FILE_PD: function () {
        return [0x00, 0xB0, 0x81, 0x00, 0x02];
    }
};

const Commands_AT = {
    SELECT_MF: function () {
        return [0x00, 0xA4, 0x00, 0x0C];
    },
    SELECT_HCA: function () {
        return [0x00, 0xA4, 0x04, 0x0C, 0x08, 0xD0, 0x40, 0x00, 0x00, 0x17, 0x01, 0x01, 0x01];
    },
    SELECT_FILE_PD: function () {
        return [0x00, 0xA4, 0x02, 0x0C, 0x02, 0xEF, 0x01];
    }
};

const PossibleAtrsForGermanHealthCards = [
    "3bd096ff81b1fe451f032e",
    "3bd096ff81b1fe451f072a",
    "3bd096ff81b1fe451fc7ea",
    "3bd097ff81b1fe451f072b"];

const PossibleAtrsForAustrianHealthCards = [
    "3bdf97008131fe588031b05202056405a100ac73d622c021",
    "3bdd96ff81b1fe451f038031b052020364041bb422810518",
    "3bdf18008131fe588031b05202046405c903ac73b7b1d422",
    "3bbd18008131fe45805102670414b10101020081053d",
    "3bbd18008131fe45805102670518b102020201810531",
    "3bbd18008131fe45805103670414b10101020081053c"
];

const runCommand = (reader, protocol, command) => {
    return new Promise((resolve, reject) => {
        reader.transmit(Buffer.from(command), 255, protocol, function (err, response) {
            if (err) {
                reject(err);
            } else {
                const status = response.slice(-2).toString("hex");

                if (status !== "9000") {
                    return reject(new Error("Card responded with error code " + status));
                } else {
                    // FIXME: the underlying pcsc library has timing/race issues when a new command is send right after
                    // getting the result of the previous one. Deferring the completion of this command to the end of
                    // the current execution queue is a workaround for now.
                    setTimeout(() => {
                        return resolve(response.slice(0, response.length - 2));
                    }, 0);
                }
            }
        });
    });
}

const readFile = async (reader, protocol, pos, length) => {
    let currentLength = 0;
    const chunks = [];

    const maxLength = 0xFD; // leave 2 bytes for status
    let currentPos = pos;
    while (currentLength < length) {
        const bytesLeft = length - currentLength;
        const readLength = (bytesLeft < maxLength) ? bytesLeft : maxLength;
        const chunk = await runCommand(reader, protocol, Commands.READ_BINARY(currentPos, readLength));
        chunks.push(chunk);
        currentLength += chunk.length;
        currentPos += readLength;
    }

    return Buffer.concat(chunks);
}

/**
 * Search for the oidString in the given ASN1 data structure and returns the value
 * @param {Buffer} data 
 * @param {String} oidString 
 */
const readInsurantDataFromASN1 = (data, oidString) => {
    //Example
    //asn1.sub[2].sub[0].typeName() = OBJECT_IDENTIFIER
    //asn1.sub[2].sub[1].sub[0].typeName() = UTF8String
    //asn1.sub[2].sub[1].sub[0].content() = Dr.

    const asn1 = ASN1.decode(data, 0);
    let result = "";

    asn1.sub.forEach(asn1Sub => {
        if (asn1Sub.sub && asn1Sub.sub.length == 2) {
            if (asn1Sub.sub[0].typeName() === "OBJECT_IDENTIFIER" && asn1Sub.sub[0].content().includes(oidString)) {
                if (asn1Sub.sub[1].sub[0].typeName() === "UTF8String" ||
                    asn1Sub.sub[1].sub[0].typeName() === "GeneralizedTime" ||
                    asn1Sub.sub[1].sub[0].typeName() === "PrintableString" ||
                    asn1Sub.sub[1].sub[0].typeName() === "NumericString") {
                    result = asn1Sub.sub[1].sub[0].content();
                }
            }
        }
    });

    return result;
}

/**
 * Helper method to reformat the date of birth
 * @param {String} dob Date of birth
 * @returns Date of birth formated to YYYYMMDD
 */
const formatDateOfBirth = (dob) => {
    return moment(new Date(dob)).format("YYYYMMDD");
}

class eGKReader extends EventEmitter {
    constructor() {
        super();

        this.pcsc = pcsclite();
        const self = this;

        this.reader = undefined;
        this.protocol = undefined;

        this.pcsc.on('reader', function (reader) {
            self.reader = reader;
            self.emit("reader-connect", reader.name);

            reader.on('error', function (err) {
                self.emit("error", err);
            });

            reader.on('end', function () {
                self.emit("reader-disconnect", reader.name);
                self.protocol = undefined;
                self.reader = undefined;
            });

            reader.on('status', function (newStatus) {
                // Check if new state is different from current one
                const changes = this.state ^ newStatus.state;
                if (changes) {
                    // Card removed from reader
                    if ((changes & this.SCARD_STATE_EMPTY) && (newStatus.state & this.SCARD_STATE_EMPTY)) {
                        self.emit("card-disconnect", reader.name);

                        reader.disconnect(reader.SCARD_LEAVE_CARD, function (err) {
                            if (err) {
                                self.emit("error", err);
                            }
                            self.protocol = undefined;
                        });
                    }
                    // Card inserted to reader
                    else if ((changes & this.SCARD_STATE_PRESENT) && (newStatus.state & this.SCARD_STATE_PRESENT)) {
                        reader.connect({
                            share_mode: this.SCARD_SHARE_SHARED
                        }, function (err, protocol) {
                            if (err) {
                                self.emit("error", err);
                            } else {
                                self.protocol = protocol;
                                self.emit("card-connect", reader.name, newStatus.atr);
                            }
                        });
                    }
                }
            });
        });

        this.pcsc.on('error', function (err) {
            self.emit("error", err);
        });
    }

    dispose() {
        if (this.reader) this.reader.close();
        this.pcsc.close();
    }

    /**
     * Gets a JSON representation of the unencrypted insurant data file on the card. 
     * The card type is selected by the ATR (https://smartcard-atr.apdu.fr/)
     * @param {Buffer} atr
     * @param {String} fallback to use if atr is not found (AT or DE)
     * @returns {JSON}
     */
    async getInsurantData(atr, fallbackType) {
        // try to detect the card type via ATR
        if (PossibleAtrsForGermanHealthCards.includes(atr.toString("hex"))) return await this.getInsurantDataDE();
        else if (PossibleAtrsForAustrianHealthCards.includes(atr.toString("hex"))) return await this.getInsurantDataAT();

        // if we are still here: use the fallback if given
        if(fallbackType && fallbackType === "DE") return await this.getInsurantDataDE();
        if(fallbackType && fallbackType === "AT") return await this.getInsurantDataAT();

        // or throw an error
        return new Promise((resolve, reject) => { reject(new Error("Unknown card with ATR " + atr.toString("hex"))) })
    }

    /**
     * Gets a JSON representation of the unencrypted insurant data file on the card. For cards from AT.
     * @returns {JSON}
     */
    async getInsurantDataAT() {
        // Select Master File/Root -> Health Care Application -> PD file
        await runCommand(this.reader, this.protocol, Commands_AT.SELECT_MF());
        await runCommand(this.reader, this.protocol, Commands_AT.SELECT_HCA());
        await runCommand(this.reader, this.protocol, Commands_AT.SELECT_FILE_PD());

        // Get all data, max. 255 bytes (maybe truncated) to get the length of TLV data
        let firstData = await runCommand(this.reader, this.protocol, Commands.READ_BINARY(0x00, 0x00));
        let sumLength = 0

        // See https://coolaj86.com/articles/asn1-for-dummies/
        // First byte = Type
        // Second byte = Data length; But above 127(7F) this is the count of bytes for the length which will follow.
        //      128(80)-127(7F) = 1 byte
        //      129(81)-127(7F) = 2 byte
        // Third and more bytes = Data length when second byte is above 127(7F)
        if (firstData[1] > 0x7F) {
            let dataLengthByteLength = parseInt(firstData[1]) & 127;
            let dataLengthBytes = new Array();
            for (let index = 1; index <= dataLengthByteLength; index++) {
                dataLengthBytes.push(firstData[index + 1])
            }

            let dataLength = Buffer.from(dataLengthBytes).readUIntBE(0, dataLengthBytes.length);
            sumLength = 3 + dataLength;
        }
        else {
            let dataLength = parseInt(firstData[1]);
            sumLength = 2 + dataLength;
        }

        const data = await readFile(this.reader, this.protocol, 0x00, sumLength);
        const personalData = {
            cardType: "ecard",
            insurantId: readInsurantDataFromASN1(data, "1.2.40.0.10.1.4.1.1"),
            dob: formatDateOfBirth(readInsurantDataFromASN1(data, "dateOfBirth")),
            firstName: readInsurantDataFromASN1(data, "givenName"),
            lastName: readInsurantDataFromASN1(data, "surname"),
            sex: readInsurantDataFromASN1(data, "gender"),
            street: "",
            houseNumber: "",
            zipCode: "",
            city: "",
            country: ""
        }
        return personalData;
    }

    /**
     * Gets a JSON representation of the unencrypted insurant data file on the card. For cards from DE.
     * @returns {JSON}
     */
    async getInsurantDataDE() {
        // Select Master File/Root -> Health Care Application -> PD file
        await runCommand(this.reader, this.protocol, Commands_DE.SELECT_MF());
        await runCommand(this.reader, this.protocol, Commands_DE.SELECT_HCA());
        await runCommand(this.reader, this.protocol, Commands_DE.SELECT_FILE_PD());

        // Read first 2 bytes from PD file to determine the length of the complete PD file
        const lenBuffer = await runCommand(this.reader, this.protocol, Commands.READ_BINARY(0x00, 0x02));
        const length = parseInt(lenBuffer.toString("hex"), 16);

        // Read the "payload" of the PD file, starting at offset 2
        const pdBuffer = await readFile(this.reader, this.protocol, 0x02, length - 2);

        // PD file is zipped, unzip
        const gunzip = util.promisify(zlib.gunzip);
        const unzipBuffer = await gunzip(pdBuffer, { finishFlush: zlib.constants.Z_SYNC_FLUSH });

        // Convert the resulting ISO-8859-15 XML string to UTF8 and return as JSON object.
        const iconv = new Iconv("ISO-8859-15", "UTF-8");
        const parseXML = util.promisify(xml2js.parseString);

        const parsedXML = await parseXML(iconv.convert(unzipBuffer), {
            explicitArray: false,
            tagNameProcessors: [xml2js.processors.stripPrefix]
        });

        const personalData = {
            cardType: "egk",
            insurantId: parsedXML.UC_PersoenlicheVersichertendatenXML.Versicherter.Versicherten_ID,
            dob: parsedXML.UC_PersoenlicheVersichertendatenXML.Versicherter.Person.Geburtsdatum,
            firstName: parsedXML.UC_PersoenlicheVersichertendatenXML.Versicherter.Person.Vorname,
            lastName: parsedXML.UC_PersoenlicheVersichertendatenXML.Versicherter.Person.Nachname,
            sex: parsedXML.UC_PersoenlicheVersichertendatenXML.Versicherter.Person.Geschlecht,
            street: parsedXML.UC_PersoenlicheVersichertendatenXML.Versicherter.Person.StrassenAdresse.Strasse,
            houseNumber: parsedXML.UC_PersoenlicheVersichertendatenXML.Versicherter.Person.StrassenAdresse.Hausnummer,
            zipCode: parsedXML.UC_PersoenlicheVersichertendatenXML.Versicherter.Person.StrassenAdresse.Postleitzahl,
            city: parsedXML.UC_PersoenlicheVersichertendatenXML.Versicherter.Person.StrassenAdresse.Ort,
            country: parsedXML.UC_PersoenlicheVersichertendatenXML.Versicherter.Person.StrassenAdresse.Wohnsitzlaendercode
        }

        return personalData;
    }
}

module.exports = eGKReader;