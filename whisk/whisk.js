const glob = require('glob');
const path = require('path');
const fs = require('fs');
const { WhiskConfig } = require('./models.js');
import * as ts from "typescript";

function filterFiles(directory, includePatterns, excludePatterns, callback) {
    const includedFiles = new Set();

    const processPattern = (pattern, isExclude, done) => {
        glob(pattern, { cwd: directory }, (err, files) => {
            if (err) {
                done(err);
                return;
            }

            files.forEach((file) => {
                if (isExclude) {
                    includedFiles.delete(file);
                } else {
                    includedFiles.add(file);
                }
            });

            done();
        });
    };

    const processPatterns = (patterns, isExclude, done) => {
        let remaining = patterns.length;

        if (remaining === 0) {
            done();
            return;
        }

        patterns.forEach((pattern) => {
            processPattern(pattern, isExclude, (err) => {
                if (err) {
                    done(err);
                    return;
                }

                remaining--;

                if (remaining === 0) {
                    done();
                }
            });
        });
    };

    processPatterns(includePatterns, false, (err) => {
        if (err) {
            callback(err);
            return;
        }

        processPatterns(excludePatterns, true, (err) => {
            if (err) {
                callback(err);
                return;
            }

            callback(null, Array.from(includedFiles));
        });
    });
}

function isPathWithin(child, ...parents) {
    for (const parent of parents) {
        if (child.startsWith(parent)) {
            return true;
        }
    }
    return false;
}

function printDiagnostics(diagnostics) {
    diagnostics.forEach(diagnostic => {
        if (diagnostic.file) {
            const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
            const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
            console.log(`${diagnostic.file.fileName} (${line + 1},${character + 1}): ${message}`);
        } else {
            console.log(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
        }
    });
}

function whiskIt(dir, settings, module) {
    let debug = settings.debug;
    let whiskConfig;
    if (fs.existsSync(path.join(dir, 'whisk.json'))) {
        whiskConfig = new WhiskConfig(JSON.parse(fs.readFileSync(path.join(dir, 'whisk.json'))));
    } else {
        whiskConfig = new WhiskConfig({});
    }
    // If gametests exist in both packs
    const tsconfigPath = path.join(dir, '/packs/data/gametests/tsconfig.json');
    if (fs.existsSync(tsconfigPath) && fs.existsSync('./data/gametests/src')) {
        // Create TS declarations
        try {
            const config = ts.readConfigFile(tsconfigPath);
            if (config.error) {
                throw new Error(config.error);
            }
            const parsedCommandLine = ts.parseJsonConfigFileContent(
                config.config,
                ts.sys,
                path.dirname(tsconfigPath)
            );
            parsedCommandLine.options.declaration = true;
            parsedCommandLine.options.emitDeclarationOnly = true;

            const program = ts.createProgram({
                rootNames: parsedCommandLine.fileNames,
                options: parsedCommandLine.options
            });

            const emitResult = program.emit();
        
            if (emitResult.emitSkipped) {
                const diagnostics = ts.getPreEmitDiagnostics(program).concat(emitResult.diagnostics);
                printDiagnostics(diagnostics);
                throw new Error('TypeScript compilation failed');
            }

            const outputPath = path.join(dir, '/packs/data/gametests/', parsedCommandLine.options.outDir);
            if (!fs.existsSync(outputPath)) {
                throw new Error('Declaration not found');
            }
            const projectRoot = process.env.ROOT_DIR;
            filterFiles(outputPath, ['**/*.d.ts'], [], (err, files) => {
                if (err) {
                    throw new Error(err);
                }
                files.forEach(file => {
                    const targetPath = path.join(projectRoot, '/packs/data/gametests/src/', path.relative(outputPath, file));
                    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
                    fs.copyFileSync(file, targetPath);
                });
            });
        } catch (e) {
            console.error(e);
        }
    }
    filterFiles(dir, whiskConfig.include, whiskConfig.exclude, (err, files) => {
        if (err) {
            throw new Error(err);
        }

        if (files.includes('config.json')) {
            const config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json')));
            // Setup default paths
            let bp = './packs/BP';
            let rp = './packs/RP';
            let dataPath = './packs/data';
            if (config.packs) {
                if (config.packs.behaviorPack) {
                    bp = config.packs.behaviorPack;
                }
                if (config.packs.resourcePack) {
                    rp = config.packs.resourcePack;
                }
            }
            if (config.regolith && config.regolith.dataPath) {
                dataPath = config.regolith.dataPath;
            }
            bp = path.normalize(path.join(dir, bp));
            rp = path.normalize(path.join(dir, rp));
            dataPath = path.normalize(path.join(dir, dataPath));
            // Check filters
            if (config.regolith && fs.existsSync(path.join(process.env.ROOT_DIR, 'config.json'))) {
                if (config.regolith.filterDefinitions && config.regolith.profiles && config.regolith.profiles.default && config.regolith.profiles.default.filters) {
                    const projectConfig = JSON.parse(fs.readFileSync(path.join(process.env.ROOT_DIR, 'config.json')));
                    let projectUsedFilters = [];
                    for (const filter of Object.keys(projectConfig.regolith.filterDefinitions)) {
                        if (projectConfig.regolith.filterDefinitions[filter].url && Object.keys(projectConfig.regolith.profiles).some((p) => projectConfig.regolith.profiles[p].filters && projectConfig.regolith.profiles[p].filters.some((f) => f.filter === filter))) {
                            projectUsedFilters.push(filter);
                        }
                    }
                    let missingFilters = [];
                    for (const filter of Object.keys(config.regolith.filterDefinitions)) {
                        if (config.regolith.filterDefinitions[filter].url && config.regolith.profiles.default.filters.some((f) => f.filter === filter)) {
                            if (!projectUsedFilters.includes(filter)) {
                                missingFilters.push(filter);
                            }
                        }
                    }
                    if (missingFilters.length > 0) {
                        throw new Error(`Missing filters: ${missingFilters.join(', ')}`);
                    }
                }
            }
            // Copy files
            for (const file of files) {
                if (fs.statSync(path.join(dir, file)).isDirectory()) {
                    continue;
                }
                const absPath = path.normalize(path.join(dir, file));
                if (isPathWithin(absPath, bp, rp, dataPath)) {
                    if (debug) {
                        console.log(`Copying ${module.name}:${file}`);
                    }
                    let targetPath;
                    // Fix this code
                    if (isPathWithin(absPath, bp)) {
                        targetPath = path.join('BP', absPath.replace(bp, ''))
                    } else if (isPathWithin(absPath, rp)) {
                        targetPath = path.join('RP', absPath.replace(rp, ''))
                    } else if (isPathWithin(absPath, dataPath)) {
                        targetPath = path.join('data', absPath.replace(dataPath, ''))
                    }
                    if (debug) {
                        console.log(`Target path ${targetPath}`);
                    }
                    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
                    fs.copyFileSync(absPath, targetPath);
                }
            }
        }
    });
}

exports.whiskIt = whiskIt;
