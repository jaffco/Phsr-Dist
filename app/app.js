// Generic Strings
const root_url = "https://electro-smith.github.io/Programmer"

// New changes involve reading from sources.json to find the 'sources' we should pull from
// Those sources replace the previously hard coded 'examples.json' file, and should otherwise 
// function the same.

// The changes should primarily only affect gatherExampleData

// When imported the examples will have the original data located in the .json file
// as well as the 'source' field containing the data structure used to find the example

var data = { 
    platforms: [],
    examples: [],
    no_device: true,
    sel_platform: null,
    sel_example: null,
    firmwareFile: null,
    blinkFirmwareFile: null,
    bootloaderFirmwareFile: null,
    displayImportedFile: false,
    displaySelectedFile: false
}

// Global Buffer for reading files
var ex_buffer

// Gets the root url
// should be https://localhost:9001/Programmer on local
// and https://electro-smith.github.io/Programmer on gh-pages
function getRootUrl() {
    // Normalize to the base directory (ensure trailing slash) and remove query string
    var url = window.location.href.split('?')[0];
    if (!url.endsWith('/')) {
        url = url.substring(0, url.lastIndexOf('/') + 1);
    }
    return url;
}

// Reads the specified file containing JSON example meta-data
// function gatherExampleData()
// {
//     // Get Source list as data 
//     var self = this // assign self to 'this' before nested function calls...
//     var src_url = getRootUrl().concat("data/sources.json") 
//     var raw = new XMLHttpRequest();
//     raw.open("GET", src_url, true);
//     raw.responseType = "text"
//     raw.onreadystatechange = function ()
//     {
//         if (this.readyState === 4 && this.status === 200) {
//             var obj = this.response; 
//             buffer = JSON.parse(obj);
//             buffer.forEach( function(ex_src) {
//                 // Launch another request with async function to load examples from the 
//                 // specified urls 
//                 // This will fill examples directly, and replace the importExamples/timeout situation.
//                 var ext_raw = new XMLHttpRequest();
//                 ext_raw.open("GET", ex_src.data_url, true);
//                 ext_raw.responseType = "text"
//                 ext_raw.onreadystatechange = function ()
//                 {
//                     if (this.readyState === 4 && this.status === 200) {
//                         // Now this.response will contain actual example data 
//                         var ext_obj = this.response;
//                         ex_buffer = JSON.parse(ext_obj);
//                         // Now we could just fill the examples data
//                         // ex_buffer.forEach( function(ex_data) {
//                         //     console.log("%s - %s", ex_src.name, ex_data.name);
//                         // })
//                         const unique_platforms = [...new Set(ex_buffer.map(obj => obj.platform))]
//                         // This needs to be fixed to 'ADD' examples
//                         //self.examples = data
//                         self.examples.push(ex_buffer)
//                         var temp_platforms = self.platforms.push(unique_platforms)

//                         const new_platforms = [...new Set(temp_platforms.map(obj => obj))]
//                         self.platforms = new_platforms
//                     }
//                 }
//                 ext_raw.send(null)

//                     // var self = this
//                     // const unique_platforms = [...new Set(data.map(obj => obj.platform))] 
//                     // self.examples = data
//                     // self.platforms = unique_platforms
//             })
//         }
//     }
//     raw.send(null)
// }


function displayReadMe(fname)
{
    // If no selected example is present, skip showing a README
    if (!window.app || !window.app.sel_example || !window.app.sel_example.url) {
        const divEmpty = document.getElementById("readme");
        if (divEmpty) divEmpty.innerHTML = '';
        return;
    }

    var url = window.app.sel_example.url;
    fname   = fname.substring(5,fname.length-4);
    
    const div = document.getElementById("readme")

    marked.setOptions({
	renderer: new marked.Renderer(),
	highlight: function(code, language) {
	    const validLanguage = hljs.getLanguage(language) ? language : 'plaintext';
	    return hljs.highlight(validLanguage, code).value;
	},
	pedantic: false,
	gfm: true,
	breaks: false,
	sanitize: false,
	smartLists: true,
	smartypants: false,
	xhtml: false
    });
    
    
    fetch(url)
    .then(response => response.text())
    .then(text => { if (div) div.innerHTML = marked.parse(text.replace("404: Not Found", "No additional details available for this example.")); })
    .catch(err => {
        console.warn('Failed to fetch readme', url, err);
        if (div) div.innerHTML = '';
    });
}

async function readServerFirmwareFile(path, dispReadme = true)
{
    return new Promise((resolve) => {
        var buffer
        var raw = new XMLHttpRequest();
        var fname = path;
    
        if(dispReadme){
            displayReadMe(fname)
        }
    
        raw.open("GET", fname, true);
        raw.responseType = "arraybuffer"
        raw.onreadystatechange = function ()
        {
            if (this.readyState === 4 && this.status === 200) {
                resolve(this.response)
            }    
        }
        raw.send(null)
    })
}

var app = new Vue({
    el: '#app',
    template: 
    `
    <b-container class="app_body">
    <div align="center">
        <button id="detach" disabled="true" hidden="true">Detach DFU</button>
        <button id="upload" disabled="true" hidden="true">Upload</button>
        <b-form id="configForm">
            <p> <label for="transferSize"  hidden="true">Transfer Size:</label>
            <input type="number" name="transferSize"  hidden="true" id="transferSize" value="1024"></input> </p>
            <p> <span id="status"></span> </p>

            <p><label hidden="true" for="vid">Vendor ID (hex):</label>
            <input hidden="true" list="vendor_ids" type="text" name="vid" id="vid" maxlength="6" size="8" pattern="0x[A-Fa-f0-9]{1,4}">
            <datalist id="vendor_ids"> </datalist> </p>

            <div id="dfuseFields" hidden="true">
                <label for="dfuseStartAddress" hidden="true">DfuSe Start Address:</label>
                <input type="text" name="dfuseStartAddress" id="dfuseStartAddress"  hidden="true" title="Initial memory address to read/write from (hex)" size="10" pattern="0x[A-Fa-f0-9]+">
                <label for="dfuseUploadSize" hidden="true">DfuSe Upload Size:</label>
                <input type="number" name="dfuseUploadSize" id="dfuseUploadSize" min="1" max="2097152" hidden="true">
            </div>
        </b-form>
    </div>
    <b-row align="center" class="app_column">
        <div>
            <div class="walkthrough" id="walkthrough">
                <div class="title jaffx-text hero-custom-font gradient-text-rainbow fade-step delay-1">Hello, Jamie.</div>
                <div class="fade-step delay-2">Please connect your JuTron via USB-C</div>
                <div class="fade-step delay-3">Once connected, press link</div>
                <div style="margin-top:10px;">
                    <button id="link" class="link-btn">Link</button>
                </div>
                <div id="walkthroughFinal" class="final-message"></div>
            </div>
            <!-- Flashing status UI (hidden until flashing starts) -->
            <div id="flashStatus" class="walkthrough flash-status" hidden>
                <div class="title hero-custom-font gradient-text-rainbow">Flashing Firmware</div>
                <div class="fade-step" style="animation-duration:1200ms;">Please keep the device connected and do not unplug.</div>
                <div style="margin-top:16px; width:360px; display:flex; gap:12px; align-items:center; justify-content:center;">
                    <progress id="heroProgressBar" class="dfu-progress-bar" max="100" value="0"></progress>
                    <div id="heroProgressPercent" class="dfu-progress-percent">0%</div>
                </div>
                <div id="heroProgressLabel" class="fade-step" style="animation-duration:1200ms;margin-top:10px;">Preparing…</div>
            </div>
            <dialog id="prelinkDialog" class="prelink-dialog">
                <div class="prelink-content">
                    <h3>Hold footswitch</h3>
                    <p>
                    Please press and hold the footswitch on your pedal until the faceplate lights turn off. 
                    When the lights go off, press Continue below to link your device.
                    After clicking Continue, your device should appear as "Daisy Bootloader - Paired" 
                    </p>
                    <div class="prelink-buttons">
                        <button id="prelinkCancel" class="link-btn">Cancel</button>
                        <button id="prelinkConfirm" class="link-btn">Continue</button>
                    </div>
                </div>
            </dialog>
            <!-- Minimal hidden placeholders to keep DFU scripts happy -->
            <button id="connect" hidden></button>
            <span id="status" hidden></span>
            <div id="downloadLog" hidden></div>
            <div id="dfuInfo" hidden></div>
            <!-- Additional placeholders so trimmed UI still supports DFU scripts -->
            <button id="blink" hidden></button>
            <button id="bootloader" hidden></button>
            <button id="download" hidden></button>
            <input type="file" id="firmwareFile" hidden />
        </div>
        </b-row>
        <!-- Remaining UI intentionally removed to present a single-step walkthrough. -->
    </b-row>        
    
    </b-container>
    `,
    data: data,
    computed: {
        platformExamples: function () {
        	
            return this.examples.filter(example => example.platform === this.sel_platform)
        }
    },
    created() {
        console.log("Page Created")
    },
    mounted() {
        var self = this
        console.log("Mounted Page")
        //var fpath = getRootUrl().concat("bin/examples.json");
        //gatherExampleData()
        // setTimeout(function(){
        //     self.importExamples(buffer)
        // }, 1000)
        this.importExamples()
    },
    methods: {
        importExamples() {
            // var self = this
            // const unique_platforms = [...new Set(data.map(obj => obj.platform))] 
            // self.examples = data
            // self.platforms = unique_platforms
            // New code below:
            // Get Source list as data 
            var self = this // assign self to 'this' before nested function calls...
            var src_url = getRootUrl().split("?")[0].concat("data/sources.json") //need to strip out query string
            var raw = new XMLHttpRequest();
            raw.open("GET", src_url, true);
            raw.responseType = "text"
            raw.onreadystatechange = function ()
            {
                if (this.readyState === 4 && this.status === 200) {
                    var obj = this.response;
                    buffer = JSON.parse(obj);
                    buffer.forEach( function(ex_src) {
                        // Launch another request with async function to load examples from the 
                        // specified urls 
                        // This will fill examples directly, and replace the importExamples/timeout situation.
                        var ext_raw = new XMLHttpRequest();
                        ext_raw.open("GET", ex_src.data_url, true);
                        ext_raw.responseType = "text"
                        ext_raw.onreadystatechange = function ()
                        {
                            // This response will contain example data for the specified source.
                            if (this.readyState === 4 && this.status === 200) {
                                var ext_obj = this.response;
                                ex_buffer = JSON.parse(ext_obj);
                                const unique_platforms = [...new Set(ex_buffer.map(obj => obj.platform))]
                                ex_buffer.forEach( function(ex_dat) {
                                    //  Add "source" to example data
                                    ex_dat.source = ex_src
                                    
                                    self.examples.sort(function (i1, i2){ 
                                        return i1.name.toLowerCase() < i2.name.toLowerCase() ? -1 : 1
                                    })
                                    self.examples.push(ex_dat)
                                })
                                unique_platforms.forEach( function(u_plat) {
                                    if (!self.platforms.includes(u_plat)) {
                                        self.platforms.push(u_plat)
                                    }
                                })
                            }
                        }
                        ext_raw.send(null)

                            // var self = this
                            // const unique_platforms = [...new Set(data.map(obj => obj.platform))] 
                            // self.examples = data
                            // self.platforms = unique_platforms
                    })
                }
            }
            raw.send(null)
        },
        programChanged(){
        	var self = this

            // Read new file
            self.firmwareFileName = self.sel_example.name
            this.displaySelectedFile = true;
            var srcurl = self.sel_example.source.repo_url
            //var expath = srcurl.substring(0, srcurl.lastIndexOf("/") +1).extend;
            var expath = srcurl.concat(self.sel_example.filepath)
        	readServerFirmwareFile(expath).then(buffer => {
                firmwareFile = buffer
            })
        },
    },
    watch: {
        firmwareFile(newfile){
            firmwareFile = null;
            this.displaySelectedFile = true;
            // Create dummy example struct
            // This updates sel_example to enable the Program button when a file is loaded
            var new_example = {
                name: newfile.name,
                description: "Imported File",
                filepath: null,
                platform: null
            }
            this.sel_example = new_example;
            let reader = new FileReader();
            reader.onload = function() {
                this.firmwareFile = reader.result;
                firmwareFile = reader.result;
            }
            reader.readAsArrayBuffer(newfile);
        },
        examples(){
            var self = this

            //grab the blink firmware file
            var blink_example = self.examples.filter(example => example.name.toLowerCase() === "blink" && example.platform === "seed")[0]

            // Read new file
            self.firmwareFileName = blink_example.name
            var srcurl = blink_example.source.repo_url
            var expath = srcurl.concat(blink_example.filepath)
        	readServerFirmwareFile(expath, false).then(buffer => {
                blinkFirmwareFile = buffer
            })

            // grab the bootloader firmware file
            var srcurl = blink_example.source.bootloader_url
        	readServerFirmwareFile(srcurl, false).then(buffer => {
                bootloaderFirmwareFile = buffer
            })

            //parse the query strings
            var searchParams = new URLSearchParams(getRootUrl().split("?")[1])
            
            var platform = searchParams.get('platform')
            var name = searchParams.get('name')
            if(platform != null && self.examples.filter(ex => ex.platform === platform)){
                self.sel_platform = platform

                if(name != null){
                    var ex = self.examples.filter(ex => ex.name === name && ex.platform === platform)[0]
                    if(ex != null){
                        self.sel_example = ex
                        this.programChanged()
                    }    
                }
            }
        }
    }
})
