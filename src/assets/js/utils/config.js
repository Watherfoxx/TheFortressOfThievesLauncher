/**
 * @author Luuxis
 * Luuxis License v1.0 (voir fichier LICENSE pour les détails en FR/EN)
 */

const pkg = require('../package.json');
const nodeFetch = require("node-fetch");
const convert = require('xml-js');
let url = pkg.user ? `${pkg.url}/${pkg.user}` : pkg.url

let config = `${url}/launcher/config-launcher/config.json`;
let news = `https://thefortressofthieves.fr/api/rss`;

class Config {
    GetConfig() {
        return new Promise((resolve, reject) => {
            nodeFetch(config).then(async config => {
                if (config.status === 200) return resolve(config.json());
                else return reject({ error: { code: config.statusText, message: 'server not accessible' } });
            }).catch(error => {
                return reject({ error });
            })
        })
    }

    async getInstanceList() {
        let urlInstance = `${url}/files`
        let instances = await nodeFetch(urlInstance).then(res => res.json()).catch(err => err)
        let instancesList = []
        instances = Object.entries(instances)

        for (let [name, data] of instances) {
            let instance = data
            instance.name = name
            instancesList.push(instance)
        }
        return instancesList
    }

    async getNews() {
        let rss = await fetch(news).then(res => res.text());
        let rssparse = JSON.parse(convert.xml2json(rss, { compact: true }));
        let data = [];
        if (rssparse.rss.channel.item.length) {
            for (let i of rssparse.rss.channel.item) {
                let item = {}
                item.title = i.title._text;
                item.content = i['content:encoded']._text;
                item.author = i['dc:creator']._text;
                item.publish_date = i.pubDate._text;
                data.push(item);
            }
        } else {
            let item = {}
            item.title = rssparse.rss.channel.item.title._text;
            item.content = rssparse.rss.channel.item['content:encoded']._text;
            item.author = rssparse.rss.channel.item['dc:creator']._text;
            item.publish_date = rssparse.rss.channel.item.pubDate._text;
            data.push(item);

        }
        return data;
    }
}


export default new Config;