'use strict';

var _ = require('lodash'),
    fs = require('fs'),
    path = require('path'),
    mkdirP = require('mkdirp'),
    AdmZip = require('adm-zip'),
    https = require('https'),
    download = require('../js/lib/util').download,
    _ = require('lodash'),
    PDFDocument = require('pdfkit');


function Printer() {

    /**
     * Returns the value of the first property found in the object.
     * If the object has no properties null is returned
     * @param obj
     * @returns {}
     */
    function getFirstPropValue(obj) {
        let values = _.values(obj);
        return values.length ? values[0] : null;
    }

    return {

        isTranslation: function (meta) {
            return !meta.project.type || meta.project.type === 'text';
        },

        getImages: function(meta){
            return new Promise(function(resolve, reject){
                let App = window.App,
                    imageRoot = path.join(App.configurator.getValue('rootdir'), 'images'),
                    imagePath = path.join(imageRoot, meta.resource_id);

                //check to see if we need to create the images directory;
                if(!fs.existsSync(imagePath)){
                    mkdirP.sync(imagePath);
                }

                //if the zip file isn't downloaded yet, go get it.
                let dest = path.join(imagePath, 'images.zip');
                if(!fs.existsSync(dest)) {
                    //let out = fs.createWriteStream(dest);
                    // TRICKY: right now we have to hard code the urls until the api is updated
                    let url = App.configurator.getValue("mediaServer") + '/obs/jpg/1/en/obs-images-360px.zip';
                    console.log('downloading images from', url);
                    download(url, dest, true).then(function() {
                        let zip = new AdmZip(dest);
                        zip.extractAllTo(imagePath, true);

                        let directories = fs.readdirSync(imagePath).filter(function(file) {
                            return fs.statSync(path.join(imagePath, file)).isDirectory();
                        });
                        directories.forEach(function(dir){
                            let dirPath = path.join(imagePath,dir),
                                files = fs.readdirSync(dirPath);
                            files.forEach(function(file){
                                let filePath = path.join(imagePath,dir,file),
                                    newPath = path.join(imagePath,file);
                                fs.renameSync(filePath, newPath);
                            });

                            //remove the empty directory
                            fs.rmdir(dirPath);
                        });
                        resolve();
                    }).catch(function(err) {
                        reject(err);
                    });
                } else {
                    resolve();
                }
            });
        },

        /**
         * Generates a pdf of the target translation
         * @param translation an array of frames
         * @param meta the target translation manifest and other info
         * @param filename the path where the export will be saved
         * @param options {includeIncompleteFrames: boolean, includeImages: boolean}
         * @returns {Promise.<boolean>}
         */
        targetTranslationToPdf: function (translation, meta, filename, options) {
            // validate input
            if(filename === null || filename === '') {
                return Promise.reject('The filename is empty');
            }
            let isTranslation = this.isTranslation(meta),
                App = window.App,
                imageRoot = path.join(App.configurator.getValue('rootdir'), "images"),
                imagePath = path.join(imageRoot, meta.resource_id);

            return new Promise(function(resolve, reject) {
                if(isTranslation) {
                    // normalize input
                    let chapters = _.mapValues(_.groupBy(translation, function(obj) {
                        //console.debug('map chapter values', obj);
                        return obj.meta.chapterid;
                    }), function(chapter, key) {
                        let frames = _.mapKeys(chapter, function(obj) {
                            //console.debug('map chapter keys', obj);
                            return obj.meta.frameid;
                        });
                        //console.debug('forming chapter', frames);
                        let formatReference = getFirstPropValue(frames); // refer to one of the frames for the format
                        console.debug(formatReference);
                        let chapterObj = {
                            id: key,
                            title: frames.title || key,
                            reference: frames.reference === undefined ? null : frames.reference,
                            format: formatReference.meta.format
                        };
                        delete frames.reference;
                        delete frames.title;
                        chapterObj.frames = _.sortBy(_.filter(frames, function(o) {
                            return o.transcontent !== '';
                        }), function(f) {
                            //console.debug('sort frames',f);
                            return f.meta.frame;
                        });
                        return chapterObj;
                    });
                    let project = {
                        format: chapters['00'].format,
                        title: chapters['00'].title
                    };
                    delete chapters['00'];
                    project.chapters = _.sortBy(_.filter(chapters, function(o) {
                        return o.frames.length > 0;
                    }), 'id');
                    chapters = null;

                    if(project.format === 'default') {
                        // the default format is currently dokuwiki
                        let doc = new PDFDocument({
                            bufferPages: true,
                            margins:{
                                top: 72,
                                bottom: 50,
                                left: 72,
                                right: 72
                            }
                        });
                        doc.pipe(fs.createWriteStream(filename + '.pdf'));

                        // default meta
                        doc.info.Title = project.title.transcontent || meta.project.name;
                        //doc.info.Author = 'Joel Lonbeck'; // todo: translators
                        //doc.info.Subject = 'an unrestricted, visual mini-Bible in any language'; // todo: project sub-title
                        doc.info.Keywords = meta.target_language.name;

                        // book title
                        doc.fontSize(25)
                            .text(project.title.transcontent, 72, doc.page.height / 2, {align: 'center'});

                        // TOC placeholders
                        doc.addPage();
                        let lastTOCPage = doc.bufferedPageRange().count;
                        let tocPages = {
                            start: lastTOCPage - 1
                        };
                        doc.fontSize(25)
                            .text(' ', 72, 72)
                            .moveDown();
                        _.forEach(project.chapters, function(chapter) {
                            doc.fontSize(10)
                                .text(' ')
                                .moveDown();
                            let currPage = doc.bufferedPageRange().count;
                            if(lastTOCPage !== currPage) {
                                // record toc page split
                                tocPages[chapter.id] = currPage - 1;
                                lastTOCPage = currPage;

                                // give room for header on new page
                                doc.fontSize(25)
                                    .text(' ', 72, 72)
                                    .moveDown();
                            }
                        });

                        // book body
                        _.forEach(project.chapters, function(chapter) {
                            // chapter title
                            doc.addPage();
                            doc.fontSize(20)
                                .text(chapter.title.transcontent || chapter.title.meta.title, 72, doc.page.height / 2, {align: 'center'});
                            chapter.page = doc.bufferedPageRange().count;

                            // frames
                            doc.addPage();
                            _.forEach(chapter.frames, function(frame) {
                                if(options.includeIncompleteFrames === true || frame.completed === true) {
                                    if (options.includeImages === true) {
                                        console.debug(meta);
                                        console.debug(frame);
                                        // TRICKY: right now all images are en
                                        var imgPath = path.join(imagePath, meta.resource_id + "-en-" + frame.meta.chapterid + "-" + frame.meta.frameid + ".jpg");
                                        doc.image(imgPath, {width:doc.page.width - 72*2});
                                    }
                                    doc.moveDown()
                                        .fontSize(10)
                                        .text(frame.transcontent);
                                }
                            });

                            // chapter reference
                            if(chapter.reference !== null) {
                                doc.moveDown()
                                    .fontSize(10)
                                    .text(chapter.reference.transcontent);
                            }
                        });

                        // number pages
                        let range = doc.bufferedPageRange();
                        for(let i = range.start; i < range.start + range.count; i ++) {
                            doc.switchToPage(i);
                            doc.fontSize(10)
                                .text(i + 1, 72, doc.page.height - 50 - 12, {align: 'center'});
                        }

                        // write TOC
                        let currTocPage = tocPages.start;
                        doc.switchToPage(currTocPage);
                        // TODO: display correct title of TOC based on the project
                        doc.fontSize(25)
                            .text('Table of Contents', 72, 72)
                            .moveDown();
                        _.forEach(project.chapters, function(chapter) {
                            if(tocPages[chapter.id] !== undefined && tocPages[chapter.id] !== currTocPage) {
                                currTocPage = tocPages[chapter.id];
                                doc.switchToPage(currTocPage);
                                doc.fontSize(10)
                                    .text(' ')
                                    .moveUp();
                            }
                            doc.switchToPage(currTocPage);
                            doc.fontSize(10)
                                .text(chapter.title.transcontent || chapter.title.meta.title)
                                .moveUp()
                                .text(chapter.page + '', {align: 'right'})
                                .moveDown();
                        });

                        doc.end();
                        resolve(true);
                    } else {
                        // we don't support anything but dokuwiki right now
                        reject('We only support exporting OBS projects for now');
                    }
                } else {
                    // TODO: support exporting other target translation types if needed e.g. notes, words, questions
                    reject('We do not support exporting that project type yet');
                }
            });
        }
    };
}

module.exports.Printer = Printer;
