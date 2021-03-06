/**
 * Created by macdja38 on 2016-04-17.
 */
"use strict";
const cluster = require('cluster');
global.cluster = cluster;

var Configs = require("./lib/config.js");
var config = new Configs("config");
var auth = new Configs("auth");

var git = require('git-rev');

var ConfigsDB = require("./lib/configDB.js");
var configDB;
var permsDB;
var perms;

var r;
var conn;

var raven;
var ravenClient;

if (auth.get("sentryURL", "") != "") {
  console.log("Sentry Started".yellow);
  git.long((commit)=> {
    git.branch((branch)=> {
      ravenClient = require('raven');
      raven = new ravenClient.Client(auth.data.sentryURL, {
        release: commit + "-" + branch,
        transport: new ravenClient.transports.HTTPSTransport({ rejectUnauthorized: false })
      });
      //raven's patch global seems to have been running synchronously and delaying the execution of other code.
      raven.patchGlobal(function (result) {
        process.exit(1);
      });

      raven.on('logged', function (e) {
        console.log("Error reported to sentry!: ".green + e.id);
      });

      raven.on('error', function (e) {
        // The event contains information about the failure:
        //   e.reason -- raw response body
        //   e.statusCode -- response status code
        //   e.response -- raw http response object

        console.error('Could not report event to sentry');
        //console.error(e.reason);
        //console.error(e.statusCode);
        //console.error(e.response);
      })
    })
  });
}

function loadConfigs() {
  return new Promise((resolve)=> {
    global.conn.then((con)=> {
      configDB = new ConfigsDB("servers", client, con);
      global.configDB = configDB;
      permsDB = new ConfigsDB("permissions", client, con);
      perms = new Permissions(permsDB);
      resolve(Promise.all([configDB.reload(), permsDB.reload()]).then(()=> {
        resolve(true);
      }).catch(console.error));
    })
  })
}

if (cluster.isMaster && config.get("shards", 2) > 1) {
  // Fork workers.
  var shards = config.get("shards", 2);
  var startShard = config.get("shardStart", 0);
  var localShards = config.get("localShards", 2);
  var lastRestart = 0;
  var restartQueue = 0;
  var workers = [];
  if (!config.get("webOnly", false)) {
    console.log(`This is the master, starting ${shards} shards`.green);
    for (let i = startShard; i < (startShard + localShards); i++) {
      console.log(`Scheduling shard ${i}`);
      setTimeout(function () {
        console.log(`Starting worker ${i} ${typeof(i)} ${typeof(shards)}`);
        workers.push(cluster.fork({ id: i, shards: shards }));
        lastRestart = Date.now();
      }, 7500 * (i - startShard));
    }
  }

  var Website = require("./www");
  var website = new Website(config.get("website", { port: 8000 }).port);

  cluster.on('exit', (deadWorker, code, signal) => {
    console.log(`worker ${deadWorker.process.pid} died`);
    let id = workers.indexOf(deadWorker);
    setTimeout(()=> {
      workers[id] = cluster.fork({ id: id + startShard, shards: shards });
      console.log(`worker ${workers[id].process.pid} born`);
      lastRestart = Date.now();
    }, Math.max(0, (lastRestart + 5000) - Date.now()));
  });
} else {

  var Discord = require("discord.js");
  console.log(`Worker id ${process.env.id} Shard count ${process.env.shards}`);
  var client = new Discord.Client({
    forceFetchUsers: true,
    autoReconnect: true,
    shardId: parseInt(process.env.id || "0"),
    shardCount: parseInt(process.env.shards || "1")
  });

  global.r = require('rethinkdb');
  r = global.r;
  global.conn = r.connect(auth.get("reThinkDB", {}));
  conn = global.conn;

  var Permissions = require("./lib/permissions.js");

  var key = auth.get("key", null);
  if (key == "key") {
    key = null;
  }

  var now = require("performance-now");
  var Parse = require("./lib/newParser.js");

  var colors = require('colors');

  var request = require('request');

  var prefix = [];

  var hasBeenReady = false;

  var moduleList = [];
  var middlewareList = [];

  var feeds;

  var mention;
  var name;
  var id;

  client.on('message', (msg)=> {
    if (msg.author && msg.author.id === id) return;
    if (!configDB) return;
    if (!perms) return;
    let t1 = now();
    let l;
    let mod;
    let ware;

    // handle per server prefixes.
    if (msg.channel.server) {
      l = configDB.get("prefix", prefix, { server: msg.channel.server.id });
      if (l == null) {
        l = prefix;
      } else {
        l.push(...prefix.filter(p => l.indexOf(p) < 0));
      }
    } else {
      l = prefix;
    }
    //console.log(`Prefix ${l}`);
    //Message middleware starts here.
    for (ware in middlewareList) {
      if (middlewareList.hasOwnProperty(ware) && middlewareList[ware].ware.onMessage) {
        middlewareList[ware].ware.onMessage(msg, perms)
      }
    }
    if (msg.author.id === "85257659694993408" && msg.content.indexOf("crashnow") > 0) {
      process.exit(0);
    }
    var command = Parse.command(l, msg, { "allowMention": id, "botName": name });
    //Reload command starts here.
    if (command.command === "reload" && msg.author.id === "85257659694993408") {
      if (command.flags.indexOf("a") > -1) {
        reload();
      } else {
        reloadTarget(msg, command, perms, l, moduleList, middlewareList)
      }
      return;
    }

    //Command middleware starts here.
    if (command) {
      for (ware in middlewareList) {
        if (middlewareList.hasOwnProperty(ware) && middlewareList[ware].ware.onCommand) {
          middlewareList[ware].ware.onCommand(msg, command, perms, l)
        }
      }
    }
    for (ware in middlewareList) {
      if (middlewareList.hasOwnProperty(ware) && middlewareList[ware].ware.changeMessage) {
        msg = middlewareList[ware].ware.changeMessage(msg, perms)
      }
    }
    if (command) {
      for (ware in middlewareList) {
        if (middlewareList.hasOwnProperty(ware) && middlewareList[ware].ware.changeCommand) {
          command = middlewareList[ware].ware.changeCommand(msg, command, perms, l)
        }
      }
    }
    if (command) {
      console.log("Command Used".blue);
      console.dir(command, { depth: 2 });
      var t2 = now();
      if (msg.channel.server) {
        console.log("s:".blue + (process.env.id) + " s: ".magenta + msg.channel.server.name + " c: ".blue + msg.channel.name + " u: ".cyan +
          msg.author.username + " m: ".green + msg.content.replace(/\n/g, "\n    ") + " in ".yellow + (t2 - t1) + "ms".red);
      }
      for (mod in moduleList) {
        //console.log(moduleList[mod].commands.indexOf(command.command));
        if (moduleList.hasOwnProperty(mod) && moduleList[mod].commands.indexOf(command.commandnos) > -1) {
          try {
            if (moduleList[mod].module.onCommand(msg, command, perms, moduleList, mod) === true) {
              return;
            }
          } catch (error) {
            if (raven) {
              raven.captureError(error, {
                user: msg.author,
                extra: {
                  mod: mod,
                  server: msg.channel.server.id,
                  server_name: msg.channel.server.name,
                  channel: msg.channel.id,
                  channel_name: msg.channel.name,
                  command: command,
                  msg: msg.content
                }
              }, (result)=> {
                msg.reply("Sorry their was an error processing your command. The error is ```" + error +
                  "``` reference code `" + raven.getIdent(result) + "`");
                console.error(error, raven.getIdent(result));
              });
            } else {
              console.error(error);
            }
          }
        }
      }
    }
    //apply misc responses.
    for (mod in moduleList) {
      //console.log(command.command);
      //console.log(moduleList[mod].commands);
      //console.log(moduleList[mod].commands.indexOf(command.command));
      if (moduleList.hasOwnProperty(mod) && moduleList[mod].module.checkMisc) {
        try {
          if (moduleList[mod].module.checkMisc(msg, perms, l) === true) {
            break;
          }
        } catch (error) {
          if (raven) {
            raven.captureError(error, {
              user: msg.author,
              extra: {
                mod: mod,
                server: msg.channel.server.id,
                server_name: msg.channel.server.name,
                channel: msg.channel.id,
                channel_name: msg.channel.name,
                command: command,
                msg: msg.content
              }
            });
          }
          console.error(error);
          console.error(error.stack);
        }
      }
    }
    if (msg.channel.server) {
      /*console.log("s:".blue + (process.env.id) + " s: ".magenta + msg.channel.server.name + " c: ".blue + msg.channel.name + " u: ".cyan +
       msg.author.username + " m: ".green + msg.content.replace(/\n/g, "\n    ") + " in ".yellow + (t2 - t1) + "ms".red); */
    } else {
      console.log("u: ".cyan + msg.author.username + " m: ".green + msg.content.replace(/\n/g, "\n    ").rainbow +
        " in ".yellow + (t2 - t1) + "ms".red);
    }
  });

  client.on('error', (error)=> {
    if (raven) {
      raven.captureException(error);
    }
    console.error(error);
    console.error(error.stack);
  });

  /* client.on('warn', (error)=> {
   console.error(`Warning`, error);
   }); */

  client.on('disconnect', ()=> {
    console.log("Disconnect".red);
    for (let i in moduleList) {
      if (moduleList.hasOwnProperty(i)) {
        if (moduleList[i].module.onDisconnect) {
          moduleList[i].module.onDisconnect();
        }
      }
    }
  });

//When a connection is made initialise stuff.
  client.on('ready', ()=> {
    console.log("Got ready");
    loadConfigs().then(()=> {
      id = client.user.id;
      mention = "<@" + id + ">";
      name = client.user.name;
      console.log(`Loading modules for Shard ${process.env.id} / ${process.env.shards}`.cyan);
      let Feeds = require('./lib/feeds');
      feeds = new Feeds({ client, r, conn, configDB });
      reload();
      console.log(`-------------------`.magenta);
      console.log(`Ready as ${client.user.username}`.magenta);
      console.log(`Mention ${mention}`.magenta);
      console.log(`Shard ${process.env.id} / ${process.env.shards}`.magenta);
      console.log(`-------------------`.magenta);
      if (!hasBeenReady) {
        hasBeenReady = true;
        /*
         setTimeout(updateCarbon, 3600000)
         */
      }
    }).catch(e => {console.error(e)});
  });


//Initiate a connection To Discord.
  if (auth.get("tokens", false)) {
    console.log(`token: ${auth.get("tokens", {})[parseInt(process.env.id)]}`.red);
    client.loginWithToken(auth.get("tokens", {})[parseInt(process.env.id)]).catch((error)=> {
      console.error("Error logging in.");
      console.error(error);
      console.error(error.stack);
    })
  } else {
    console.log(`token: ${auth.get("token", {})}`.blue);
    client.loginWithToken(auth.get("token", {})).catch((error)=> {
      console.error("Error logging in.");
      console.error(error);
      console.error(error.stack);
    })
  }


  //When bot is added to a new server tell carbon about it.
  client.on('serverCreated', (server)=> {
    var configs = [configDB.serverCreated(server), permsDB.serverCreated(server)];
    Promise.all(configs).then(()=> {
      for (let middleware of middlewareList) {
        if (middleware.module) {
          try {
            if (middleware.module.onServerCreated) {
              console.log("Notifying a module a server was created!".green);
              middleware.module.onServerCreated(server);
            }
          } catch (error) {
            console.error(error);
          }
        }
      }
      for (let module of moduleList) {
        if (module.module) {
          try {
            if (module.module.onServerCreated) {
              console.log("Notifying a module a server was created!".green);
              module.module.onServerCreated(server);
            }
          } catch (error) {
            console.error(error);
          }
        }

      }
    }).catch(console.error)
  });


  /**
   * logout on SIGINT
   * if logging out does not happen within 5s exit with an error.
   */
  process.on('SIGINT', ()=> {
    setTimeout(() => {
      process.exit(1)
    }, 5000);
    console.log("Logging out.");
    for (let middleware of middlewareList) {
      if (middleware.module) {
        if (middleware.module.onDisconnect) {
          console.log("Trying to Remove Listeners!".green);
          middleware.module.onDisconnect();
        }
      }
    }
    for (let module of moduleList) {
      if (module.module) {
        if (module.module.onDisconnect) {
          console.log("Trying to Remove Listeners!".green);
          module.module.onDisconnect();
        }
      }
    }
    middlewareList = [];
    moduleList = [];
    client.logout(()=> {
      console.log("Bye");
      process.exit(0);
    });
  });
}

process.on('uncaughtException', (e)=> {
  console.error(e);
  console.error(e.stack);
});

function reload() {
  prefix = configDB.get("prefix", ["!!", "//", "/"], { server: "*" });
  console.log("defaults");
  console.log(prefix);
  name = client.user.name;
  for (let middleware in middlewareList) {
    if (middlewareList.hasOwnProperty(middleware)) {
      try {
        if (middlewareList[middleware].module && middlewareList[middleware].module.onDisconnect) {
          console.log(`Removing Listeners for middleware ${middleware}`.green);
          middlewareList[middleware].module.onDisconnect();
        }
        delete middlewareList[middleware];
      } catch (error) {
        console.error(error);
      }
    }
  }
  for (let module in moduleList) {
    if (moduleList.hasOwnProperty(module)) {
      try {
        if (moduleList[module].module && moduleList[module].module.onDisconnect) {
          console.log(`Removing Listeners for module ${module}`.green);
          moduleList[module].module.onDisconnect();
        }
        delete moduleList[module];
      } catch (error) {
        console.error(error);
      }
    }
  }
  middlewareList = [];
  moduleList = [];
  var middlewares = config.get("middleware");
  var modules = config.get("modules");
  let moduleVariables = { client, config, raven, auth, configDB, r, conn, perms, feeds };
  for (let module in modules) {
    if (modules.hasOwnProperty(module)) {
      try {
        let Modul = require(modules[module]);
        let mod = new Modul(moduleVariables);
        if (mod.onReady) mod.onReady();
        moduleList.push({ "commands": mod.getCommands(), "module": mod });

      }
      catch
        (error) {
        console.error(error);
      }
    }
  }
  for (let middleware in middlewares) {
    if (middlewares.hasOwnProperty(middleware)) {
      try {
        let ware = new (require(middlewares[middleware]))(moduleVariables);
        if (ware.onReady) ware.onReady();
        middlewareList.push({ "ware": ware });
      } catch (error) {
        console.error(error);
      }
    }
  }
}

/**
 * Updates Carbonitrix's website telling it the bot's new server count.
 */

function updateCarbon() {
  console.log("Attempting to update Carbon".green);
  if (process.uptime() < 60) {
    console.log("Not updating carbon to ensure all servers are loaded".green);
    return;
  }
  if (key) {
    request(
      {
        url: 'https://www.carbonitex.net/discord/data/botdata.php',
        body: { key: key, servercount: client.servers.length },
        json: true
      },
      function (error, response, body) {
        if (!error && response.statusCode == 200) {
          console.log(body)
        }
        else if (error) {
          console.error(error);
        }
        else {
          console.error("Bad request or other");
          console.error(response.body);
        }
      }
    );
  }
}


function reloadTarget(msg, command, perms, l, moduleList, middlewareList) {
  for (var module in moduleList) {
    if (moduleList.hasOwnProperty(module) && moduleList[module].module.constructor.name === command.args[0]) {
      if (moduleList[module].module.onDisconnect) {
        moduleList[module].module.onDisconnect();
      }
      var modules = config.get("modules");
      delete require.cache[require.resolve(modules[command.args[0]])];
      msg.reply("Reloading " + command.args[0]);
      console.log("Reloading ".yellow + command.args[0].yellow);
      var mod = new (require(modules[command.args[0]]))({ client, config, raven, auth, configDB, r, conn, perms, feeds });
      if (mod.onReady) mod.onReady();
      moduleList[module].module = mod;
      moduleList[module].commands = mod.getCommands();
      console.log("Reloded ".yellow + command.args[0].yellow);
      msg.reply("Reloded " + command.args[0]);
    }
  }
}