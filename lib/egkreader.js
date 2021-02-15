const zlib = require('zlib');
const xml2js = require('xml2js');
const util = require('util')
const EventEmitter = require('events');
const pcsclite = require('pcsclite');
const Iconv = require('iconv').Iconv;

const Commands = {
    SELECT_MF: function () {
        return [0x00, 0xA4, 0x04, 0x0C, 0x07, 0xD2, 0x76, 0x00, 0x01, 0x44, 0x80, 0x00];
    },
    SELECT_HCA: function () {
        return [0x00, 0xA4, 0x04, 0x0C, 0x06, 0xD2, 0x76, 0x00, 0x00, 0x01, 0x02];
    },
    SELECT_FILE_PD: function () {
        return [0x00, 0xB0, 0x81, 0x00, 0x02];
    },
    READ_BINARY: function (offset, length) {
        // Split offset number into 2 bytes (big endian)
        const offsetBytes = [offset >> 8 && 0xFF, offset & 0xFF];
        return [0x00, 0xB0, offsetBytes[0], offsetBytes[1], length];
    }
};

const runCommand = (reader, protocol, command) => {
    return new Promise((resolve, reject) => {
        reader.transmit(Buffer.from(command), 255, protocol, function (err, response) {
            if (err) {
                reject(err);
            } else {
                const status = response.slice(-2).toString("hex");

                if (status !== "9000") {
                    reject(new Error("Card responded with error code " + status));
                } else {
                    setTimeout(() => {
                        resolve(response.slice(0, response.length - 2));
                    }, 0);
                }

                //reader.close();
                //pcsc.close();
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

    async getPatientData(options) {
        // Select Master File/Root -> Health Care Application -> PD file
        await runCommand(this.reader, this.protocol, Commands.SELECT_MF());
        await runCommand(this.reader, this.protocol, Commands.SELECT_HCA());
        await runCommand(this.reader, this.protocol, Commands.SELECT_FILE_PD());

        // Read first 2 bytes from PD file to determine the length of the complete PD file
        const lenBuffer = await runCommand(this.reader, this.protocol, Commands.READ_BINARY(0x00, 0x02));
        const length = parseInt(lenBuffer.toString("hex"), 16);

        // Read the "payload" of the PD file, starting at offset 2
        const pdBuffer = await readFile(this.reader, this.protocol, 0x02, length - 2);

        // PD file is zipped, unzip
        const gunzip = util.promisify(zlib.gunzip);
        const unzipBuffer = await gunzip(pdBuffer, { finishFlush: zlib.constants.Z_SYNC_FLUSH });

        // Create converter from ISO-8859-15 to UTF-8, because the data is encoded in ISO-8859-15
        const iconv = new Iconv("ISO-8859-15", "UTF-8");

        const parseXML = util.promisify(xml2js.parseString);
        return await parseXML(iconv.convert(unzipBuffer), {
            explicitArray: false,
            tagNameProcessors: [xml2js.processors.stripPrefix]
        });
    }
}

module.exports = eGKReader;