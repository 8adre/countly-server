var pluginManager = require('../../../../plugins/pluginManager.js'),
    asyncjs = require('async'),
    countlyDb = pluginManager.dbConnection();

function printMessage(messageType, ...message) {
    console[messageType]('[nxret._id <- nxret.uid][' + messageType + '] ', ...message);
}

printMessage("log", "Started...");

class WriteHandler {

    constructor() {
        this.currentUid = null;
        this.candidates = [];
        this.nDocsWithDups = 0;
        this.nDocs = 0;
        this.nInsertRequests = 0;
        this.nRemoveRequests = 0;
    }

    flush() {
        var requests = [];
        if (this.candidates.length === 0) {
            return [];
        }
        if (this.candidates.length>1){
            this.nDocsWithDups++;
        }
        this.nDocs++;
        var stats = this.candidates.map(function(doc){
            var str = JSON.stringify(doc);
            return {
                "doc": doc, 
                "removeId": doc._id,
                "fs": parseInt(doc.fs),
                "str": str,
                "len": str.length
            }
        });
        stats.sort(function(a, b) {
            return a.fs - b.fs || b.len - a.len;
        });
        var winningItem = stats[0];
        winningItem.doc._id = winningItem.doc.uid;
        var self = this;
        
        requests.push({
            insertOne: { "document": winningItem.doc }
        });
        self.nInsertRequests++;

        stats.forEach(function(item){
            requests.push({
                deleteOne: { "filter": { _id: item.removeId }}
            });
            self.nRemoveRequests++;
        });
        return requests;
    }

    process(newDoc) {
        if (this.currentUid === null) {
            this.currentUid = newDoc.uid;
            this.candidates.push(newDoc);
            return [];
        }
        if (this.currentUid === newDoc.uid) {
            // a duplicate of prevDoc
            this.candidates.push(newDoc);
            return [];
        }
        if (this.current !== newDoc.uid){
            // uid changed, flush
            var requests = this.flush();
            this.currentUid = newDoc.uid;
            this.candidates = [newDoc];
            return requests;
        }
    }

    end() {
        return this.flush();
    }
}

countlyDb.collection('apps').find({}).toArray(function(appsErr, apps) {

    var hasAnyErrors = false;

    if (!appsErr && apps) {
        asyncjs.eachSeries(apps, upgrade, function() {
            if (hasAnyErrors) {
                printMessage("error", "-------------------------------------------------");
                printMessage("error", "Finished with ERRORS. Please check previous logs.");
                printMessage("error", "-------------------------------------------------");
            }
            else {
                printMessage("log", "Finished.");
            }
            countlyDb.close();
        });
    }
    else {
        printMessage("error", "Error at app fetch. Stopped. ", appsErr);
        countlyDb.close();
        return;
    }

    function upgrade(app, done) {
        printMessage("log", "(" + app.name + ") Fixing...");
        var cursor = countlyDb.collection('app_nxret' + app._id).find({$expr: {$ne: ["$_id", "$uid"] } }).sort({uid: -1});
        var requests = [];
        var nScanned = 0;
        var nSkipped = 0;
        var bulkWritePromises = [];

        var writeHandler = new WriteHandler();

        cursor.forEach(function(nxret) {
            if (nxret.uid === null || nxret.uid === undefined) {
                printMessage("log", "(" + app.name + ") Skipping a doc with empty uid");
                nSkipped++;
            }
            else if (nxret._id === nxret.uid) {
                printMessage("log", "(" + app.name + ") Skipping a doc whose _id = uid");
                nSkipped++;
            }
            else {
                var newRequests = writeHandler.process(nxret);
                newRequests.forEach(function(nReq) {
                    requests.push(nReq);
                });
                if (requests.length >= 1000) {
                    bulkWritePromises.push(getBulkWritePromise(requests));
                    requests = [];
                }
                nScanned++;
            }
        }, function(err) {
            if (err) {
                printMessage("error", "cursor.forEach stopped execution: ", err);
            }
            var newRequests = writeHandler.end();
            newRequests.forEach(function(nReq) {
                requests.push(nReq);
            });
            if (requests.length > 0) {
                bulkWritePromises.push(getBulkWritePromise(requests));
                requests = [];
            }
            Promise.all(bulkWritePromises).then(finalizeApp).catch(function(err) {
                hasAnyErrors = true;
                printMessage("error", err);
                printMessage("error", "----------------------------------------------");
                printMessage("error", "(" + app.name + ")", "ERRORS, see previous", "\n");
                return done();
            });
        });

        function getBulkWritePromise(reqArr) {
            return new Promise(function(resolve/*, reject*/) {
                countlyDb.collection('app_nxret' + app._id).bulkWrite(reqArr, function(err, response) {
                    if (err) {
                        printMessage("error", "Bulk write completed with errors: ", err);
                    }
                    if (response && response.result) {
                        resolve({err: err, result: response.result});
                    }
                    else {
                        resolve({err: err, result: null});
                    }
                });
            }).catch(function(err) {
                printMessage("error", "(" + app.name + ")", "error in Promise:", err);
                return Promise.resolve({err: err, result: null});
            });
        }

        function finalizeApp(responses) {
            var hasError = false;
            var nInserted = 0;
            var nRemoved = 0;
            responses.forEach(function(response) {
                hasError = hasError || response.err;
                if (response.result) {
                    if (response.result.nInserted) {
                        nInserted += response.result.nInserted;
                    }
                    if (response.result.nRemoved) {
                        nRemoved += response.result.nRemoved;
                    }
                }
            });

            if (hasError) {
                hasAnyErrors = true;
                printMessage("error", "----------------------------------------------");
                printMessage("error", "(" + app.name + ")", "ERRORS, see previous", "\n");
            }
            else {
                printMessage("log", "(" + app.name + ")", "scanned =", nScanned, "/", "skipped =", nSkipped);
                if (nScanned > 0) {
                    printMessage("log", "(" + app.name + ")", "insert reqs=", writeHandler.nInsertRequests, "/", "remove reqs =", writeHandler.nRemoveRequests);
                    printMessage("log", "(" + app.name + ")", "inserted =", nInserted, "/", "removed =", nRemoved);
                    printMessage("log", "(" + app.name + ")", "docs with dup =", writeHandler.nDocsWithDups, "/", "docs =", writeHandler.nDocs);
                }
                if (writeHandler.nInsertRequests === nInserted && writeHandler.nRemoveRequests === nRemoved) {
                    printMessage("log", "(" + app.name + ")", "Successful.", "\n");
                }
                else {
                    hasAnyErrors = true;
                    printMessage("error", "(" + app.name + ")", "ERROR: # of requests doesn't match with inserted/removed.", "\n");
                }
            }
            return done();
        }
    }
});