import { createWriteStream } from 'fs';
import archiver from 'archiver';
import fs from 'fs';
import nbt from 'prismarine-nbt';
import fetch from 'node-fetch';

const settings = process.argv[2] ? JSON.parse(process.argv[2]) : {};
const config = JSON.parse(fs.readFileSync(process.env.ROOT_DIR + "/config.json", 'utf8'));
const scopedEval = (scope, script) => Function(`"use strict"; ${script}`).bind(scope)();
const defaultName = "${config.name}.mcworld";
const output = createWriteStream(process.env.ROOT_DIR + '/' + scopedEval({config:config}, "return `" + (settings.name || defaultName) + "`;"));
const archive = archiver('zip');

output.on('close', function () {
    console.log('MCAddon file created.');
});

archive.on('error', function (err) {
    throw err;
});

archive.pipe(output);

let location = null;

if (settings.worldFolder) {
    location = process.env.APPDATA.substring(0, process.env.APPDATA.lastIndexOf('\\')) +
        "\\Local\\Packages\\Microsoft.MinecraftUWP_8wekyb3d8bbwe\\LocalState\\games\\com.mojang\\minecraftWorlds\\" + settings.worldFolder;

    if (!fs.existsSync(location)) {
        console.error('World folder ' + location + ' does not exist');
        archive.abort();
        process.exit(1);
    }
} else if (settings.worldPath) {
    location = settings.worldPath;

    if (!fs.existsSync(location)) {
        console.error('World path ' + location + ' does not exist');
        archive.abort();
        process.exit(1);
    }
}
if (location) {
    console.log(`Using world: ${location}`);
    // append world folder to archive
    archive.glob('**/*', { cwd: location, ignore: ['*.dat'] });
    if (settings.worldVersion !== void 0) {
        await (async () => {
            const file = fs.readFileSync(location + '/level.dat');
            const result = await nbt.parse(file);
            const level = result.parsed;
            const type = result.type;
            if (settings.worldVersion === 'release') {
                const response = await fetch('https://raw.githubusercontent.com/MCMrARM/mc-w10-versiondb/master/versions.json.min')
                const versions = (await response.json()).filter(v => v[2] === 0);
                settings.worldVersion = versions[versions.length - 1][0].split('.').map(x => parseInt(x));
            }
            if (settings.worldVersion === null) {
                console.log('Removing world version');
                delete level.value.MinimumCompatibleClientVersion;
                delete level.value.InventoryVersion;
                delete level.value.lastOpenedWithVersion;
            } else {
                console.log('Changing world version to ' + settings.worldVersion.join('.'));
                while (settings.worldVersion.length < 5) {
                    settings.worldVersion.push(0);
                }
                level.value.MinimumCompatibleClientVersion = nbt.list(nbt.int(settings.worldVersion.slice(0, 5)));
                level.value.InventoryVersion = nbt.string(settings.worldVersion.slice(0, 3).join('.'));
                level.value.lastOpenedWithVersion = level.value.MinimumCompatibleClientVersion;
            }
            const source = nbt.writeUncompressed(level, type);
            const header = Buffer.alloc(8)
            header.writeInt16LE(9);
            header.writeInt16LE(source.length, 4)
            archive.append(Buffer.concat([header, source]), { name: 'level.dat' });
        })();
    }
}

// append packs
archive.directory('RP/', 'resource_packs/RP/');
archive.directory('BP/', 'behavior_packs/BP/');

archive.finalize();
