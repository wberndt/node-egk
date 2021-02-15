const eGKReader = require('../lib/egkreader');

const egk = new eGKReader();
egk.on('reader-connect', (reader) => { console.log(`Reader connected: ${reader}`) });
egk.on('reader-disconnect', (reader) => { console.log(`Reader disconnected: ${reader}`) });
egk.on('card-disconnect', (reader) => { console.log(`Card disconnected from reader: ${reader}`) });
egk.on('card-connect', async (reader) => {
    console.log(`Card connected to reader: ${reader}, reading data...`);
    try {
        const result = await egk.getPatientData();
        console.log("Got data: ", result);
        //egk.dispose();
    } catch (err) {
        console.log("Got error: ", err);
    }

});

egk.on('error', (err) => { console.log(`Error: ${err.message}`, err) });

