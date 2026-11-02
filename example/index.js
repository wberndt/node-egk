const eGKReader = require('../lib/egkreader');

// Only use readers that do not have "Windows" in their name (e.g. Windows Hello)
const cardReader = new eGKReader({readerFilter: /^(?!.*Windows).*$/});

cardReader.on('reader-connect', (reader) => { console.log(`Reader "${reader}" connected.`) });

cardReader.on('reader-disconnect', (reader) => {
    console.log(`Reader "${reader}" disconnected, shutting down.`);
    reader.dispose();
});

cardReader.on('card-connect', async (reader, atr) => {
    console.log(`Card inserted into reader "${reader}", getting data...`);
    try {
        const userData = await cardReader.getInsurantData(atr, "DE");
        console.log(JSON.stringify(userData));
    } catch (err) {
        console.log("Error: ", err);
    }
});

cardReader.on('card-disconnect', (reader) => { console.log(`No card in reader "${reader}"`) });

cardReader.on('error', (err) => { console.log(`Error: ${err.message}`, err) });