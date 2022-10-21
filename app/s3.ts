import AWS = require("aws-sdk");
import { ipcMain, BrowserWindow } from 'electron';
// tslint:disable-next-line:max-line-length
import { ListBucketsOutput, ListObjectsOutput, GetObjectOutput, PutObjectRequest, PutObjectOutput } from "aws-sdk/clients/s3";
import { RequestType, LogRequest, IRequestTracked, RequestTracking } from "./request-tracking";
import fs = require('fs');
import os = require('os');
import path = require('path');
import { AWSError } from "aws-sdk";
import { JobManager } from "./job-manager";
import { IAccount } from "./model";
let defaultDownloadLocation = path.join(os.homedir(), 'Downloads');

AWS.config.apiVersions = {
    s3: '2006-03-01',
};

export class S3Service implements IRequestTracked {
    public trackingService: RequestTracking;
    private window: BrowserWindow;
    private jobs: JobManager;
    constructor() {
        ipcMain.on('S3-ListBuckets', (event: string, arg: IAccount) => {
            this.listBuckets(arg).then((result) => {
                this.window.webContents.send('S3-BucketsListed', { account: arg, buckets: result.Buckets });
            });
        });
        ipcMain.on('S3-ListObjects', (event: string, arg: any) => {
            this.listObjects(arg.account, arg.bucket, arg.prefix);
        });
        ipcMain.on('S3-RequestDownload', (event: string, arg: any) => {
            this.downloadFile(arg.jobID, arg.account, arg.bucket, arg.key, arg.saveTo);
        });
        ipcMain.on('S3-RequestBulkUpload', (event: string, arg: any) => {
            this.bulkUpload(arg.files, arg.parents);
        });
    }

    public initialize(w: BrowserWindow, t: RequestTracking, j: JobManager) {
        this.window = w;
        this.trackingService = t;
        this.jobs = j;
    }

    private downloadFile(jobID: string, account: IAccount, bucket: string, key: string, saveTo = "") {
        let r = this.getObject(account, bucket, key);
        let originalPath = path.parse(key);
        let filename = `${originalPath.name}${originalPath.ext}`;
        saveTo = saveTo ? saveTo : defaultDownloadLocation;
        if (!fs.existsSync(saveTo)) {
            this.window.webContents.send('S3-LocationNotFound', { path: saveTo });
            return;
        }
        let downloadFile = path.join(saveTo, filename);
        if (fs.existsSync(downloadFile)) {
            filename = `${originalPath.name}_1${originalPath.ext}`;
            downloadFile = path.join(saveTo, filename);
        }
        this.jobs.addJob(jobID, 'download', r.request, filename, saveTo, downloadFile);
        r.result.then((_) => {
            let file = fs.createWriteStream(downloadFile);
            file.write(_.Body);
            file.close();
            // tslint:disable-next-line:max-line-length
            this.window.webContents.send('S3-DownloadSuccessful', { account, bucket, key, saveAs: downloadFile });
        }).catch((err) => {
            // tslint:disable-next-line:max-line-length
            this.window.webContents.send('S3-DownloadFailed', { account, bucket, key, saveAs: downloadFile });
        });
    }

    private bulkUpload(files: Array<{
        jobID: string, account: IAccount, bucket: string, filePath: string, newPath: string,
        // tslint:disable-next-line:align
    }>, location: string[]) {
        let jobs: Array<Promise<any>> = [];
        // TODO: consolidate/reformat files array, they all belong to 1 account anyway
        // Temporary: just take the first file's account as the result
        let account: IAccount;
        if (files.length) {
            account = files[0].account;
        }
        files.forEach((f) => {
            let file = fs.readFileSync(f.filePath);
            let filepath = path.parse(f.filePath);
            let filename = `${filepath.name}${filepath.ext}`;
            let r = this.upload(f.account, f.bucket, f.newPath, file);
            // tslint:disable-next-line:max-line-length
            let resultPromise = this.jobs.addManagedUploadJob(f.jobID, 'upload', r.request, filename, f.newPath, f.filePath);
            let parents = [f.account.id, f.bucket].concat(f.newPath.split('/'));
            parents.splice(parents.length - 1, 1);
            parents = this.pruneParentsArray(parents);
            jobs.push(
                resultPromise.then((_) => {
                    this.window.webContents.send('S3-UploadSuccessful', { account: f.account, parents, filename });
                    return Promise.resolve(_);
                }).catch((err) => {
                    this.window.webContents.send('S3-UploadFailed', { account: f.account, parents, filename });
                    return Promise.reject(err);
                }),
            );
        });
        Promise.all(jobs).then(() => {
            // tslint:disable-next-line:max-line-length
            this.window.webContents.send('S3-BulkUploadCompleted', { account, parents: this.pruneParentsArray(location) });
        }).catch((err) => {
            this.window.webContents.send('S3-BulkUploadFailed', { account, parents: this.pruneParentsArray(location) });
        });
    }

    private listObjects(account: IAccount, bucket: string, prefix: string, delimiter = '/') {
        let parents = [account.id, bucket].concat(prefix.split('/'));
        parents = this.pruneParentsArray(parents);
        this.window.webContents.send('S3-ListingObjects', { parents });
        this.listObjectsReq(account, bucket, prefix, delimiter).then((result) => {
            // tslint:disable-next-line:max-line-length
            this.window.webContents.send('S3-ObjectListed', { account, parents, objects: result.Contents, folders: result.CommonPrefixes });
        }).catch((err) => {
            this.window.webContents.send('S3-OperationFailed', { account, parents, error: err });
        });
    }

    private createS3Instance(acc: IAccount): AWS.S3 {
        let s3: AWS.S3;
        if (acc.url) {
            s3 = new AWS.S3({
                endpoint: acc.url,
                credentials: new AWS.SharedIniFileCredentials({
                    profile: acc.id,
                }),
            });
        } else {
            s3 = new AWS.S3({
                credentials: new AWS.SharedIniFileCredentials({
                    profile: acc.id,
                }),
            });
        }
        return s3;
    }

    @LogRequest({ type: RequestType.List })
    private listBuckets(account: IAccount): Promise<ListBucketsOutput> {
        let promise = new Promise<ListBucketsOutput>((resolve, reject) => {
            let s3 = this.createS3Instance(account);
            s3.listBuckets((err, data) => {
                if (err) { reject(err); } else { resolve(data); }
            });
        });
        return promise;
    }

    @LogRequest({ type: RequestType.List })
    // tslint:disable-next-line:max-line-length
    private listObjectsReq(account: IAccount, bucket: string, prefix: string, delimiter = '/'): Promise<ListObjectsOutput> {
        let promise = new Promise<ListObjectsOutput>((resolve, reject) => {
            let params = {
                Bucket: bucket,
                Prefix: prefix,
                Delimiter: delimiter,
            };
            let s3 = this.createS3Instance(account);
            s3.listObjectsV2(params, (err, data) => {
                if (err) {
                    reject(err);
                } else {
                    if (data.Contents) {
                        data.Contents = data.Contents.filter((_) => _.Key !== prefix);
                        data.Contents.forEach((c) => {
                            c.Key = c.Key.replace(prefix, '');
                        });
                    }
                    resolve(data);
                }
            });
        });
        return promise;
    }

    @LogRequest({ type: RequestType.Get })
    // tslint:disable-next-line:max-line-length
    private getObject(account: IAccount, bucket: string, key: string): { result: Promise<GetObjectOutput>, request: AWS.Request<GetObjectOutput, AWSError> } {
        let req;
        let promise = new Promise<GetObjectOutput>((resolve, reject) => {
            let params = {
                Bucket: bucket,
                Key: key,
            };
            let s3 = this.createS3Instance(account);
            req = s3.getObject(params, (err, data) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(data);
                }
            });
        });
        return { result: promise, request: req };
    }

    @LogRequest({ type: RequestType.Put })
    private upload(account: IAccount, bucket: string, key: string, data: Buffer): { request: AWS.S3.ManagedUpload } {
        let req;
        let params = {
            Body: data,
            Bucket: bucket,
            Key: key,
        };
        let s3 = this.createS3Instance(account);
        req = s3.upload(params);
        return { request: req };
    }

    private pruneParentsArray(parents: string[]): string[] {
        let res = parents.slice();
        if (res[res.length - 1] === '') {
            res.splice(res.length - 1, 1);
        }
        return res;
    }
}
