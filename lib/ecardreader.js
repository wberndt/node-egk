const EventEmitter = require('events');
const pcsclite = require('pcsclite');
const ASN1 = require("@lapo/asn1js");
const moment = require("moment");

const Commands = {
    SELECT_MF: function () {
        return [0x00, 0xA4, 0x00, 0x0C];
    },
    SELECT_HCA: function () {
        return [0x00, 0xA4, 0x04, 0x0C, 0x08, 0xD0, 0x40, 0x00, 0x00, 0x17, 0x01, 0x01, 0x01];
    },
    SELECT_FILE_PD: function () {
        return [0x00, 0xA4, 0x02, 0x0C, 0x02, 0xEF, 0x01];
    },
    READ_BINARY: function (offset, length) {
        // Split offset number into 2 bytes (big endian)
        const offsetBytes = [offset >> 8 && 0xFF, offset & 0xFF];
        return [0x00, 0xB0, offsetBytes[0], offsetBytes[1], length];
    }
};

const runCommand = (reader, protocol, command, ...goodstatus) => {
    return new Promise((resolve, reject) => {
        reader.transmit(Buffer.from(command), 255, protocol, function (err, response) {
            if (err) {
                reject(err);
            } else {
                const status = response.slice(-2).toString("hex");
                //console.log("Status:", status);

                if (!goodstatus.includes(status)) {
                    return reject(status);
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

/**
 * Reads a before selected EF file and returns the data bytes
 * @param {*} reader 
 * @param {*} protocol 
 * @param {Byte} pos Starting position
 * @param {Byte} length Bytes to read with one command
 * @returns Whole array of bytes
 */
const readFile = async (reader, protocol, pos, length) => {
    let currentLength = 0;
    const chunks = [];

    const maxLength = 0xFD; // leave 2 bytes for status
    let currentPos = pos;
    while (currentLength < length) {
        const bytesLeft = length - currentLength;
        const readLength = (bytesLeft < maxLength) ? bytesLeft : maxLength;
        const chunk = await runCommand(reader, protocol, Commands.READ_BINARY(currentPos, readLength), "9000", "6282")
            .catch(err => {
                if (err !== "6b00")
                    new Error("Card responded with error code " + status);
            });
        if (chunk) {
            chunks.push(chunk);
            currentLength += chunk.length;
            currentPos += readLength;
        }
        else {
            currentLength = length;
        }
    }

    return Buffer.concat(chunks);
}

/**
 * Search for the oidString in the given ASN1 data structure and returns the value
 * @param {Buffer} data 
 * @param {String} oidString 
 */
const readInsurantData = (data, oidString) => {
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
 * 
 * @param {String} dob Date of birth
 * @returns Date of birth formated to YYYYMMDD
 */
const formatDateOfBirth = (dob) => {
    return moment(new Date(dob)).format("YYYYMMDD");
}

class eCardReader extends EventEmitter {
    constructor() {
        super();
        moment.locale("de");

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
                                self.emit("card-connect", reader.name);
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

    // Returns a JSON representation of the unencrypted insurant data file on the card.
    async getInsurantData() {
        // Select Master File/Root -> Health Care Application -> PD file
        await runCommand(this.reader, this.protocol, Commands.SELECT_MF(), "9000");
        await runCommand(this.reader, this.protocol, Commands.SELECT_HCA(), "9000");
        await runCommand(this.reader, this.protocol, Commands.SELECT_FILE_PD(), "9000");

        const data = await readFile(this.reader, this.protocol, 0x00, 0xF0);

        // const data = await runCommand(this.reader, this.protocol, Commands.READ_BINARY(0x00, 0x00), "9000");
        // console.log(data);
        const personalData = {
            Versicherter: {
                Versicherten_ID: readInsurantData(data, "1.2.40.0.10.1.4.1.1"),
                Person: {
                    Geburtsdatum: formatDateOfBirth(readInsurantData(data, "dateOfBirth")),
                    Vorname: readInsurantData(data, "givenName"),
                    Nachname: readInsurantData(data, "surname"),
                    Geschlecht: readInsurantData(data, "gender"),
                    StrassenAdresse: {
                        Postleitzahl: "",
                        Ort: "",
                        Land: {
                            Wohnsitzlaendercode: ""
                        },
                        Strasse: "",
                        Hausnummer: ""
                    }
                }
            }
        }
        return personalData;
    }
}

module.exports = eCardReader;