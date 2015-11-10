
var timequeue = require('timequeue'),
    pg = require('pg'),
    fs = require('fs'),
    request = require('request'),
    FeedParser = require('feedparser');

var Monitor = module.exports = function Monitor(feeds, rate, dbconfig, emitter) {
    this.feeds = feeds;
    this.dbconfig = dbconfig;
    this.emitter = emitter;

    dbconfig.connectionString = this.buildDBConnectionString(dbconfig);

    this.setupDatabase(dbconfig, emitter);

    // hook up feed monitoring
    this.feedQueryInterval = setInterval(this.checkForOldFeeds.bind(this, dbconfig, emitter), rate);
    emitter.on('old-feed', this.queryFeed.bind(this, dbconfig, emitter));
    emitter.on('feed-parsed', this.updateTimestamp.bind(this, dbconfig, emitter));
    emitter.on('entry', this.persistEntry.bind(this, dbconfig, emitter));
};

Monitor.prototype.buildDBConnectionString = function(dbconfig) {
    if (dbconfig['connectionString']) {
        return dbconfig['connectionString'];
    }

    var user = dbconfig['user'],
        pw = dbconfig['password'],
        url = dbconfig['url'],
        port = dbconfig['port'],
        dbname = dbconfig['dbname'];

    return 'postgres://' + user + ':' + pw + '@' + url + ':' + port + '/' + dbname;
};

Monitor.prototype.runDBScript = function(client, filename, cb) {
    var script = fs.readFileSync(filename).toString();
    client.query(script, cb);
};

Monitor.prototype.setupDatabase = function(dbconfig, emitter) {
    pg.connect(dbconfig.connectionString, function(err, client, done) {
        function handleError(err) {
            if(client) {
                done(client);
            }
            emitter.emit('error', err);
        }

        if (err) { return handleError(err); }

        this.runDBScript(client, './init-feed-db.sql', function(err, result) {
            if (err) { return handleError(err); }

            var feedChunks = [];
            for (var i = 1; i <= this.feeds.length; ++i) {
                feedChunks.push('($' + i + ', DEFAULT)');
            }

            client.query('INSERT INTO feeds (feed, lastUpdated) VALUES ' + feedChunks.join(', '),
                this.feeds, function(err, result) {

                if (err) { return handleError(err); }

                console.log('SETUP!');
                done();
            });

        }.bind(this));
    }.bind(this));
};

Monitor.prototype.checkForOldFeeds = function(dbconfig, emitter) {
    pg.connect(dbconfig.connectionString, function(err, client, done) {
        function handleError(err) {
            if(client) {
                done(client);
            }
            emitter.emit('error', err);
        }

        if (err) { return handleError(err); }

        console.log('***');

        var query = client.query('SELECT * FROM feeds WHERE lastUpdated < NOW() - INTERVAL \'15 seconds\' OR lastUpdated IS NULL');

        query.on('error', handleError);

        query.on('row', function(row) {
            console.log(row.feed);
            emitter.emit('old-feed', row.feed);
            // this.queryFeed(row.feed, dbconfig, emitter);
        }.bind(this));

        query.on('end', function(result) {
            console.log('done...')
            done();
        });

    }.bind(this));
};

Monitor.prototype.queryFeed = function(dbconfig, emitter, feed) {
    function handleError(err) {
        emitter.emit('error', err);
    }

    var options = {
        url: feed,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_8_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/31.0.1650.63 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml'
        }
    };

    var req = request(options);
    var feedparser = new FeedParser();

    req.on('error', handleError);
    req.on('response', function(res) {
        if (res.statusCode != 200) {
            return this.emit('error', new Error('bad status code: ' + res.statusCode));
        }
        this.pipe(feedparser);
    });

    feedparser.on('error', handleError);
    feedparser.on('readable', function() {
        var stream = this,
            entry;

        while(entry = stream.read()) {
            emitter.emit('entry', entry, feed);
        }

        emitter.emit('feed-parsed', feed);
    });
};

Monitor.prototype.updateTimestamp = function(dbconfig, emitter, feed) {
    pg.connect(dbconfig.connectionString, function(err, client, done) {
        function handleError(err) {
            if(client) {
                done(client);
            }
            emitter.emit('error', err);
        }

        if (err) { return handleError(err); }

        client.query('UPDATE feeds SET lastUpdated = NOW() WHERE feed = $1', [feed], function(err, result) {
            if (err) { return handleError(err); }
            done();
        });
    });
};

Monitor.prototype.persistEntry = function(dbconfig, emitter, entry, feed) {
    console.log('>> ', entry.guid);

    pg.connect(dbconfig.connectionString, function(err, client, done) {
        function handleError(err) {
            if(client) {
                done(client);
            }
            emitter.emit('error', err);
        }

        if (err) { return handleError(err); }

        client.query('SELECT * FROM entries WHERE id = $1', [entry.guid], function(err, result) {
            if (err) { return handleError(err); }

            if (result.rows.length) { return done(); }

            client.query('INSERT INTO entries (id, feed) VALUES ($1, $2)', [entry.guid, feed], function(err, result) {
                if (err) { return handleError(err); }

                emitter.emit('new-entry', entry, feed);
                done();
            });
        });
    });
};