const eGKReader = require('../lib/egkreader');

const egk = new eGKReader();
egk.on('reader-connect', (reader) => { console.log(`Reader "${reader}" connected.`) });

egk.on('reader-disconnect', (reader) => {
    console.log(`Reader "${reader}" disconnected, shutting down.`);
    egk.dispose();
});

egk.on('card-connect', async (reader) => {
    console.log(`Card inserted into reader "${reader}", getting data...`);
    try {
        const userData = await egk.getInsurantData();
        console.log(JSON.stringify(userData));
    } catch (err) {
        console.log("Error: ", err);
    }
});

egk.on('card-disconnect', (reader) => { console.log(`No card in reader "${reader}"`) });

egk.on('error', (err) => { console.log(`Error: ${err.message}`, err) });

