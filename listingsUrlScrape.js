const AWS = require('aws-sdk');
const util = require('util');
const rp = require('request-promise');
const cheerio = require('cheerio');

const CL_APA_PAGINATION_SIZE = 120; // TODO: Infer batch size from the first query.

class ApartmentJob{
    constructor(region, cityCode, offset=0, limit=CL_APA_PAGINATION_SIZE, skip=1){
        this.region = region;
        this.cityCode = cityCode;
        this.offset = offset;
        this.limit = limit;
        this.skip = skip;
    }
}

function filterWithSkip(arr, skip){
    return arr.filter((element, index) => { return index % skip === 0; })
}

function getApartmentsUrl(region, cityCode, offset=0){
    const craigslistUrl = 'https://%s.craigslist.ca/d/apts-housing-for-rent/search/%s/apa?s=%s';
    return util.format(craigslistUrl, region, cityCode, offset);
}

function getApartmentsList(apartmentJob){
    const options = {
        uri: getApartmentsUrl(apartmentJob.region, apartmentJob.cityCode, apartmentJob.offset),
        transform: function (body) {
            return cheerio.load(body);
        }
    };
    return rp(options)
        .then(($) => {
            let listingRows = $('.content ul.rows li.result-row');
            let listings = [];
            listingRows.each((i, listingRow) => {
                let priceHtml = $('.result-price', listingRow);
                let price = null;
                if (priceHtml) {
                    if (priceHtml.html()) {
                        price = priceHtml.html().replace('$', '');
                    }
                }

                const listing = {
                    'dataPid': String(listingRow.attribs['data-pid']),
                    'url': $('.result-title', listingRow).attr('href'),
                    'title': $('.result-title', listingRow).text(),
                    'price': Number(price),
                    'currency': 'cad',
                }
                listings.push(listing);
            });
            return listings;
        })
        .then(listings => {
            return filterWithSkip(listings.slice(0, apartmentJob.limit), apartmentJob.skip)
        })
        .catch((err) => {
            console.log(err);
        });
}

async function crawlApartments (region, cityCode, amount, skip){
    let n = 0;
    let apartmentJobs = [];
    while (n < amount){
        let remaining = amount - n;
        let batchSize = remaining >= CL_APA_PAGINATION_SIZE ? CL_APA_PAGINATION_SIZE : remaining;
        let apartmentJob = new ApartmentJob(region, cityCode, n, batchSize, skip);
        apartmentJobs.push(apartmentJob);
        n += batchSize;
    }
    return apartmentJobs.reduce( ( promise, apartmentJob ) => {
        return promise.then( (allApartments) => {
            console.log(util.format("On offset %s with limit=%s skip=%s", apartmentJob.offset, apartmentJob.limit, apartmentJob.skip));
            return getApartmentsList(apartmentJob)
                .then((newApartments) => allApartments = allApartments.concat(newApartments))
        })
    }, Promise.resolve([]));
}

function loadToDynamo(listings){
    // Set the region
    AWS.config.update({region: 'us-east-1'});

    // Create the DynamoDB service object
    docClient = new AWS.DynamoDB.DocumentClient();

    return listings.reduce( ( promise, listing ) => {
        var params = {
            TableName: 'CraigslistApartments',
            Item: listing,
        };
        return promise.then( () => {
            return new Promise((resolve, reject) => {
                docClient.put(params, function(err, data){
                    if (err) reject(err);
                    else resolve(data);
                });
            });
        })
    }, Promise.resolve());
}

module.exports = {
    listingsUrlScrape: ( async (event, context) => {
        console.log(util.format("Doing with REGION=%s, CITY_CODE=%s, AMOUNT=%s, SKIP=%s", process.env.REGION, process.env.CITY_CODE, process.env.AMOUNT, process.env.SKIP));
        const listings = await crawlApartments(process.env.REGION, process.env.CITY_CODE, process.env.AMOUNT, process.env.SKIP);
        await loadToDynamo(listings)
    })
};