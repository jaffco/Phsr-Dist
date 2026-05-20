var firmwareFile = null;
var blinkFirmwareFile = null;
var bootloaderFirmwareFile = null;
var device = null;
(function() {
    'use strict';

    function hex4(n) {
        let s = n.toString(16)
        while (s.length < 4) {
            s = '0' + s;
        }
        return s;
    }

    function hexAddr8(n) {
        let s = n.toString(16)
        while (s.length < 8) {
            s = '0' + s;
        }
        return "0x" + s;
    }

    function niceSize(n) {
        const gigabyte = 1024 * 1024 * 1024;
        const megabyte = 1024 * 1024;
        const kilobyte = 1024;
        if (n >= gigabyte) {
            return n / gigabyte + "GiB";
        } else if (n >= megabyte) {
            return n / megabyte + "MiB";
        } else if (n >= kilobyte) {
            return n / kilobyte + "KiB";
        } else {
            return n + "B";
        }
    }

    function formatDFUSummary(device) {
        const vid = hex4(device.device_.vendorId);
        const pid = hex4(device.device_.productId);
        const name = device.device_.productName;

        let mode = "Unknown"
        if (device.settings.alternate.interfaceProtocol == 0x01) {
            mode = "Runtime";
        } else if (device.settings.alternate.interfaceProtocol == 0x02) {
            mode = "DFU";
        }

        const cfg = device.settings.configuration.configurationValue;
        const intf = device.settings["interface"].interfaceNumber;
        const alt = device.settings.alternate.alternateSetting;
        const serial = device.device_.serialNumber;
        let info = `${mode}: [${vid}:${pid}] cfg=${cfg}, intf=${intf}, alt=${alt}, name="${name}" serial="${serial}"`;
        return info;
    }

    function formatDFUInterfaceAlternate(settings) {
        let mode = "Unknown"
        if (settings.alternate.interfaceProtocol == 0x01) {
            mode = "Runtime";
        } else if (settings.alternate.interfaceProtocol == 0x02) {
            mode = "DFU";
        }

        const cfg = settings.configuration.configurationValue;
        const intf = settings["interface"].interfaceNumber;
        const alt = settings.alternate.alternateSetting;
        const name = (settings.name) ? settings.name : "UNKNOWN";

        return `${mode}: cfg=${cfg}, intf=${intf}, alt=${alt}, name="${name}"`;
    }

    async function fixInterfaceNames(device_, interfaces) {
        // Check if any interface names were not read correctly
        if (interfaces.some(intf => (intf.name == null))) {
            // Manually retrieve the interface name string descriptors
            let tempDevice = new dfu.Device(device_, interfaces[0]);
            await tempDevice.device_.open();
            await tempDevice.device_.selectConfiguration(1);
            let mapping = await tempDevice.readInterfaceNames();
            await tempDevice.close();

            for (let intf of interfaces) {
                if (intf.name === null) {
                    let configIndex = intf.configuration.configurationValue;
                    let intfNumber = intf["interface"].interfaceNumber;
                    let alt = intf.alternate.alternateSetting;
                    intf.name = mapping[configIndex][intfNumber][alt];
                }
            }
        }
    }

    function populateInterfaceList(form, device_, interfaces) {
        let old_choices = Array.from(form.getElementsByTagName("div"));
        for (let radio_div of old_choices) {
            form.removeChild(radio_div);
        }

        let button = form.getElementsByTagName("button")[0];

        for (let i=0; i < interfaces.length; i++) {
            let radio = document.createElement("input");
            radio.type = "radio";
            radio.name = "interfaceIndex";
            radio.value = i;
            radio.id = "interface" + i;
            radio.required = true;

            let label = document.createElement("label");
            label.textContent = formatDFUInterfaceAlternate(interfaces[i]);
            label.className = "radio"
            label.setAttribute("for", "interface" + i);

            let div = document.createElement("div");
            div.appendChild(radio);
            div.appendChild(label);
            form.insertBefore(div, button);
        }
    }

    function getDFUDescriptorProperties(device) {
        // Attempt to read the DFU functional descriptor
        // TODO: read the selected configuration's descriptor
        return device.readConfigurationDescriptor(0).then(
            data => {
                let configDesc = dfu.parseConfigurationDescriptor(data);
                let funcDesc = null;
                let configValue = device.settings.configuration.configurationValue;
                if (configDesc.bConfigurationValue == configValue) {
                    for (let desc of configDesc.descriptors) {
                        if (desc.bDescriptorType == 0x21 && desc.hasOwnProperty("bcdDFUVersion")) {
                            funcDesc = desc;
                            break;
                        }
                    }
                }

                if (funcDesc) {
                    return {
                        WillDetach:            ((funcDesc.bmAttributes & 0x08) != 0),
                        ManifestationTolerant: ((funcDesc.bmAttributes & 0x04) != 0),
                        CanUpload:             ((funcDesc.bmAttributes & 0x02) != 0),
                        CanDnload:             ((funcDesc.bmAttributes & 0x01) != 0),
                        TransferSize:          funcDesc.wTransferSize,
                        DetachTimeOut:         funcDesc.wDetachTimeOut,
                        DFUVersion:            funcDesc.bcdDFUVersion
                    };
                } else {
                    return {};
                }
            },
            error => {}
        );
    }

    // Current log div element to append to
    let logContext = null;

    // Small state for progress UI
    let currentDFUPhase = null; // 'Erasing' | 'Flashing' | null
    let progressHideTimeout = null;

    function setLogContext(div) {
        logContext = div;
    };

    // Safe DOM helpers -------------------------------------------------
    function getEl(id) {
        if (!id) return null;
        if (typeof id === 'string') return document.getElementById(id) || document.querySelector(id);
        return id;
    }

    function setText(idOrEl, text) {
        const el = typeof idOrEl === 'string' ? getEl(idOrEl) : idOrEl;
        if (!el) return;
        try { el.textContent = text; } catch (e) { /* ignore */ }
    }

    function ensureLogContext() {
        if (logContext) return logContext;
        let el = getEl('#downloadLog') || getEl('#dfuLog') || getEl('#downloadLog') || getEl('#logContext');
        if (!el) {
            el = document.createElement('div');
            el.id = 'dfuLog';
            el.style.whiteSpace = 'pre-wrap';
            el.style.fontFamily = 'monospace';
            document.body.appendChild(el);
        }
        logContext = el;
        return logContext;
    }

    function setDFUPhase(phase) {
        currentDFUPhase = phase;
        console.debug('[DFU] setDFUPhase', phase);
        // If there's a visible progress widget, update its label
        const log = ensureLogContext();
        const wrapper = log.querySelector('.dfu-progress-wrapper');
        if (wrapper) {
            const label = wrapper.querySelector('.dfu-progress-label');
            if (label) label.textContent = phase ? phase : '';
            try { wrapper.dataset.phase = phase || ''; } catch (e) {}
        }
        // Hero UI: show/hide the flashing status
        const flashStatus = getEl('#flashStatus');
        const walkthrough = getEl('#walkthrough');
        if (phase) {
            // Show hero flashing UI
            if (walkthrough) walkthrough.hidden = true;
            if (flashStatus) {
                flashStatus.hidden = false;
                flashStatus.classList.add('flash-pulse');
                const label = getEl('#heroProgressLabel'); if (label) label.textContent = phase;
            }
            // cancel any pending hide scheduled by logProgress completion
            if (progressHideTimeout) { try { clearTimeout(progressHideTimeout); } catch (e) {} progressHideTimeout = null; }
        } else {
            // Hide hero flashing UI
            if (flashStatus) {
                flashStatus.classList.remove('flash-pulse');
                flashStatus.hidden = true;
            }
            if (walkthrough) walkthrough.hidden = false;
        }
    }

    // Safe setter for disabled state with debug logging
    function safeSetDisabled(idOrEl, disabled, name) {
        const el = typeof idOrEl === 'string' ? getEl(idOrEl) : idOrEl;
        if (!name) name = (el && el.id) ? `#${el.id}` : (typeof idOrEl === 'string' ? idOrEl : 'element');
        console.debug('[UI] setDisabled', name, '=>', disabled, el);
        if (!el) {
            console.warn('[UI] element not found for', name);
            return false;
        }
        try { el.disabled = !!disabled; return true; } catch (e) { console.error('[UI] failed setDisabled', name, e); return false; }
    }

    function clearLog(context) {
        if (typeof context === 'undefined') {
            context = logContext;
        }
        if (context) {
            context.innerHTML = "";
        }
    }

    function logDebug(msg) {
        console.log(msg);
    }

    function logInfo(msg) {
        const ctx = ensureLogContext();
        let info = document.createElement("p");
        info.className = "info";
        info.textContent = msg;
        ctx.appendChild(info);
    }

    function logWarning(msg) {
        const ctx = ensureLogContext();
        let warning = document.createElement("p");
        warning.className = "warning";
        warning.textContent = msg;
        ctx.appendChild(warning);
    }

    function logError(msg) {
        const ctx = ensureLogContext();
        let error = document.createElement("p");
        error.className = "error";
        error.textContent = (msg && msg.message) ? msg.message : ('' + msg);
        ctx.appendChild(error);
        console.error('[LOG ERROR]', msg);
    }

    function logProgress(done, total) {
        try {
            const ctx = ensureLogContext();
            console.debug('[DFU] logProgress', {done: done, total: total});
        let wrapper = ctx.querySelector('.dfu-progress-wrapper');
        if (!wrapper) {
            wrapper = document.createElement('div');
            wrapper.className = 'dfu-progress-wrapper';
            wrapper.innerHTML = `<div class="dfu-progress-label" aria-live="polite">${currentDFUPhase || ''}</div>` +
                                `<progress class="dfu-progress-bar" max="100" value="0"></progress>` +
                                `<div class="dfu-progress-percent">0%</div>`;
            ctx.appendChild(wrapper);
            // record the phase that the wrapper is currently representing
            try { wrapper.dataset.phase = currentDFUPhase || ''; } catch (e) {}
        }

        const labelEl = wrapper.querySelector('.dfu-progress-label');
        const bar = wrapper.querySelector('.dfu-progress-bar');
        const pct = wrapper.querySelector('.dfu-progress-percent');

        if (currentDFUPhase) {
            labelEl.textContent = currentDFUPhase;
            try { wrapper.dataset.phase = currentDFUPhase; } catch (e) {}
        }

        // Also update hero UI if present (grab once to avoid TDZ/dup lookups)
        const heroBar = getEl('#heroProgressBar');
        const heroPct = getEl('#heroProgressPercent');

        if (typeof total === 'number' && total > 0) {
            bar.max = total;
            bar.value = done;
            const percent = Math.round((done / total) * 100);
            pct.textContent = `${percent}%`;
            // set a CSS custom property containing the percent string so our ::before fill can use it
            try { bar.style.setProperty('--pct', `${percent}%`); } catch (e) {}
            // determinate -> remove indeterminate class
            bar.classList.remove('indeterminate');
            if (heroBar) heroBar.classList.remove('indeterminate');
            if (heroBar) heroBar.max = total, heroBar.value = done;
            if (heroBar) try { heroBar.style.setProperty('--pct', `${percent}%`); } catch (e) {}
            if (heroPct) heroPct.textContent = `${percent}%`;
        } else {
            // Indeterminate
            bar.removeAttribute('value');
            pct.textContent = '…';
            // add indeterminate class to animate stripe L->R
            bar.classList.add('indeterminate');
            if (heroBar) { heroBar.classList.add('indeterminate'); heroBar.removeAttribute('value'); try { heroBar.style.removeProperty('--pct'); } catch (e) {} }
            try { bar.style.removeProperty('--pct'); } catch (e) {}
            if (heroPct) heroPct.textContent = '…';
        }

            // Clean up when complete
            if (typeof total === 'number' && done >= total) {
                const finishedPhase = (wrapper && wrapper.dataset && wrapper.dataset.phase) ? wrapper.dataset.phase : currentDFUPhase;
                labelEl.textContent = (finishedPhase ? finishedPhase + ' complete' : 'Done');
                // schedule wrapper removal and hero UI hide, but keep a handle so a new phase can cancel it
                if (progressHideTimeout) { try { clearTimeout(progressHideTimeout); } catch (e) {} }
                progressHideTimeout = setTimeout(() => {
                    try { wrapper.remove(); } catch (e) {}
                    try { const flashStatus = getEl('#flashStatus'); if (flashStatus) flashStatus.hidden = true; const walkthrough = getEl('#walkthrough'); if (walkthrough) walkthrough.hidden = false; } catch (e) {}
                    progressHideTimeout = null;
                }, 1400);
                // also update hero UI label immediately
                const heroLabel = getEl('#heroProgressLabel');
                if (heroLabel) heroLabel.textContent = (finishedPhase ? finishedPhase + ' complete' : 'Done');
            }
        } catch (err) {
            // Protect the DFU flow from UI errors; log but do not rethrow
            console.error('[DFU] logProgress error', err);
            try { logError(err); } catch (e) {}
        }
    }

    document.addEventListener('DOMContentLoaded', event => {
        // Global error hooks to surface runtime errors into the log area for debugging
        window.addEventListener('error', function(e) {
            console.error('[Global Error]', e.error || e.message, e);
            try { logError(e.error || e.message || String(e)); } catch (e) {}
        });
        window.addEventListener('unhandledrejection', function(e) {
            console.error('[UnhandledRejection]', e.reason, e);
            try { logError(e.reason || String(e)); } catch (err) {}
        });
        let connectButton = document.querySelector("#connect");
        let detachButton = document.querySelector("#detach");
        let downloadButton = document.querySelector("#download");
        let uploadButton = document.querySelector("#upload");
        let blinkButton = document.querySelector("#blink");
        let bootloaderButton = document.querySelector("#bootloader");
        let statusDisplay = document.querySelector("#status");
        let infoDisplay = document.querySelector("#usbInfo");
        let dfuDisplay = document.querySelector("#dfuInfo");
        let vidField = document.querySelector("#vid");
        let interfaceDialog = document.querySelector("#interfaceDialog");
        let interfaceForm = document.querySelector("#interfaceForm");
        let interfaceSelectButton = document.querySelector("#selectInterface");

        let searchParams = new URLSearchParams(window.location.search);
        let fromLandingPage = false;
        let vid = 0;
        // Set the vendor ID from the landing page URL
        if (searchParams.has("vid")) {
            const vidString = searchParams.get("vid");
            try {
                if (vidString.toLowerCase().startsWith("0x")) {
                    vid = parseInt(vidString, 16);
                } else {
                    vid = parseInt(vidString, 10);
                }
                vidField.value = "0x" + hex4(vid).toUpperCase();
                fromLandingPage = true;
            } catch (error) {
                console.log("Bad VID " + vidString + ":" + error);
            }
        }

        // Grab the serial number from the landing page
        let serial = "";
        if (searchParams.has("serial")) {
            serial = searchParams.get("serial");
            // Workaround for Chromium issue 339054
            if (window.location.search.endsWith("/") && serial.endsWith("/")) {
                serial = serial.substring(0, serial.length-1);
            }
            fromLandingPage = true;
        }

        let configForm = document.querySelector("#configForm");

        let transferSizeField = document.querySelector("#transferSize");
        let transferSize = 1024;
        //let transferSize = parseInt(transferSizeField.value);

        let dfuseStartAddressField = document.querySelector("#dfuseStartAddress");
        let dfuseUploadSizeField = document.querySelector("#dfuseUploadSize");

        let firmwareFileField = document.querySelector("#firmwareFile");
        // let firmwareFile = null;

        let downloadLog = document.querySelector("#downloadLog");
        let uploadLog = document.querySelector("#uploadLog");
        
        let linkButton = document.querySelector("#link");
        let prelinkDialog = document.querySelector("#prelinkDialog");
        let prelinkConfirm = document.querySelector("#prelinkConfirm");
        let prelinkCancel = document.querySelector("#prelinkCancel");

        let manifestationTolerant = true;

        //let device;

        function onDisconnect(reason) {
            if (reason) {
                setText(statusDisplay, reason);
            }

            setText(connectButton, "Connect");
            setText(infoDisplay, "");
            setText(dfuDisplay, "");
            safeSetDisabled(detachButton, true, 'detachButton');
            safeSetDisabled(uploadButton, true, 'uploadButton');
            safeSetDisabled(blinkButton, true, 'blinkButton');
            safeSetDisabled(bootloaderButton, true, 'bootloaderButton');
            safeSetDisabled(downloadButton, true, 'downloadButton');
            safeSetDisabled(firmwareFileField, true, 'firmwareFileField');
        }

        function onUnexpectedDisconnect(event) {
            if (device !== null && device.device_ !== null) {
                if (device.device_ === event.device) {
                    device.disconnected = true;
                    // Disconnects that occur outside of an explicit user action or
                    // expected manifestation shouldn't surface a status message
                    // to the user (they see it in logs). Call onDisconnect without
                    // a reason so the UI won't display the 'Device disconnected' text.
                    console.log('Device disconnected (unexpected)');
                    onDisconnect();
                    device = null;
                }
            }
        }

        async function connect(device) {
            console.debug('[DFU] connect() start', device && device.device_ && device.device_.productName);
            try {
                await device.open();
                console.debug('[DFU] device.open() succeeded');
            } catch (error) {
                onDisconnect(error);
                throw error;
            }

            // Attempt to parse the DFU functional descriptor
            let desc = {};
            try {
                desc = await getDFUDescriptorProperties(device);
            } catch (error) {
                onDisconnect(error);
                throw error;
            }

            let memorySummary = "";
            if (desc && Object.keys(desc).length > 0) {
                device.properties = desc;
                let info = `WillDetach=${desc.WillDetach}, ManifestationTolerant=${desc.ManifestationTolerant}, CanUpload=${desc.CanUpload}, CanDnload=${desc.CanDnload}, TransferSize=${desc.TransferSize}, DetachTimeOut=${desc.DetachTimeOut}, Version=${hex4(desc.DFUVersion)}`;
                if (dfuDisplay) {
                    dfuDisplay.textContent = (dfuDisplay.textContent || '') + "\n" + info;
                } else {
                    logInfo(info);
                }
                transferSizeField.value = desc.TransferSize;
                transferSize = desc.TransferSize;
                if (desc.CanDnload) {
                    manifestationTolerant = desc.ManifestationTolerant;
                }

                if (device.settings.alternate.interfaceProtocol == 0x02) {
                    if (!desc.CanUpload) {
                        safeSetDisabled(uploadButton, true, 'uploadButton');
                        safeSetDisabled(blinkButton, true, 'blinkButton');
                        safeSetDisabled(bootloaderButton, true, 'bootloaderButton');
                        safeSetDisabled(dfuseUploadSizeField, true, 'dfuseUploadSizeField');
                    }
                    if (!desc.CanDnload) {
                        safeSetDisabled(dnloadButton, true, 'dnloadButton');
                    }
                }

                if (desc.DFUVersion == 0x011a && device.settings.alternate.interfaceProtocol == 0x02) {
                    device = new dfuse.Device(device.device_, device.settings);
                    if (device.memoryInfo) {
                        let totalSize = 0;
                        for (let segment of device.memoryInfo.segments) {
                            totalSize += segment.end - segment.start;
                        }
                        memorySummary = `Selected memory region: ${device.memoryInfo.name} (${niceSize(totalSize)})`;
                        for (let segment of device.memoryInfo.segments) {
                            let properties = [];
                            if (segment.readable) {
                                properties.push("readable");
                            }
                            if (segment.erasable) {
                                properties.push("erasable");
                            }
                            if (segment.writable) {
                                properties.push("writable");
                            }
                            let propertySummary = properties.join(", ");
                            if (!propertySummary) {
                                propertySummary = "inaccessible";
                            }

                            memorySummary += `\n${hexAddr8(segment.start)}-${hexAddr8(segment.end-1)} (${propertySummary})`;
                        }
                    }
                }
            }

            // Bind logging methods
            console.debug('[DFU] binding log methods');
            device.logDebug = logDebug;
            device.logInfo = logInfo;
            device.logWarning = logWarning;
            device.logError = logError;
            device.logProgress = logProgress;

            // Clear logs
            clearLog(uploadLog);
            clearLog(downloadLog);

            // Display basic USB information
            setText(statusDisplay, '');
            setText(connectButton, 'Disconnect');
            setText(infoDisplay, (""));
                //"Name: " + device.device_.productName + "\n" +
                //"MFG: " + device.device_.manufacturerName + "\n" +
                //"Serial: " + device.device_.serialNumber + "\n"
            //);

            // Display basic dfu-util style info
            setText(dfuDisplay, formatDFUSummary(device) + "\n" + memorySummary);

            // Update buttons based on capabilities
            if (device.settings.alternate.interfaceProtocol == 0x01) {
                // Runtime
                safeSetDisabled(detachButton, false, 'detachButton');
                safeSetDisabled(uploadButton, true, 'uploadButton');
                safeSetDisabled(blinkButton, true, 'blinkButton');
                safeSetDisabled(bootloaderButton, true, 'bootloaderButton');
                safeSetDisabled(downloadButton, true, 'downloadButton');
                safeSetDisabled(firmwareFileField, true, 'firmwareFileField');
	    } else {
                // DFU
                safeSetDisabled(detachButton, true, 'detachButton');
                safeSetDisabled(uploadButton, false, 'uploadButton');
                safeSetDisabled(blinkButton, false, 'blinkButton');
                safeSetDisabled(bootloaderButton, false, 'bootloaderButton');
                safeSetDisabled(downloadButton, false, 'downloadButton');
                safeSetDisabled(firmwareFileField, false, 'firmwareFileField');
            }

            if (device.memoryInfo) {
                let dfuseFieldsDiv = document.querySelector("#dfuseFields")
                dfuseFieldsDiv.hidden = true;
                safeSetDisabled(dfuseStartAddressField, false, 'dfuseStartAddressField');
                safeSetDisabled(dfuseUploadSizeField, false, 'dfuseUploadSizeField');
                let segment = device.getFirstWritableSegment();
                if (segment) {
                    if(segment.start === 0x90000000)
                        segment.start += 0x40000
                    device.startAddress = segment.start;
                    dfuseStartAddressField.value = "0x" + segment.start.toString(16);
                    const maxReadSize = device.getMaxReadSize(segment.start);
                    dfuseUploadSizeField.value = maxReadSize;
                    dfuseUploadSizeField.max = maxReadSize;
                }
            } else {
                let dfuseFieldsDiv = document.querySelector("#dfuseFields")
                dfuseFieldsDiv.hidden = true;
                safeSetDisabled(dfuseStartAddressField, true, 'dfuseStartAddressField');
                safeSetDisabled(dfuseUploadSizeField, true, 'dfuseUploadSizeField');
            }

            return device;
        }

        function autoConnect(vid, serial) {
            dfu.findAllDfuInterfaces().then(
                async dfu_devices => {
                    let matching_devices = [];
                    for (let dfu_device of dfu_devices) {
                        if (serial) {
                            if (dfu_device.device_.serialNumber == serial) {
                                matching_devices.push(dfu_device);
                            }
                        } else if (dfu_device.device_.vendorId == vid) {
                            matching_devices.push(dfu_device);
                        }
                    }

                    if (matching_devices.length == 0) {
                        setText(statusDisplay, 'No device found.');
                    } else {
                        if (matching_devices.length == 1) {
                            setText(statusDisplay, 'Connecting...');
                            device = matching_devices[0];
                            console.log(device);
                            device = await connect(device);
                        } else {
                            setText(statusDisplay, "Multiple DFU interfaces found.");
                        }
                        vidField.value = "0x" + hex4(matching_devices[0].device_.vendorId).toUpperCase();
                        vid = matching_devices[0].device_.vendorId;
                    }
                }
            );
        }

        // vidField.addEventListener("change", function() {
        //     vid = parseInt(vidField.value, 16);
        // });

        // transferSizeField.addEventListener("change", function() {
        //     transferSize = parseInt(transferSizeField.value);
        // });

        // dfuseStartAddressField.addEventListener("change", function(event) {
        //     const field = event.target;
        //     let address = parseInt(field.value, 16);
        //     if (isNaN(address)) {
        //         field.setCustomValidity("Invalid hexadecimal start address");
        //     } else if (device && device.memoryInfo) {
        //         if (device.getSegment(address) !== null) {
        //             device.startAddress = address;
        //             field.setCustomValidity("");
        //             dfuseUploadSizeField.max = device.getMaxReadSize(address);
        //         } else {
        //             field.setCustomValidity("Address outside of memory map");
        //         }
        //     } else {
        //         field.setCustomValidity("");
        //     }
        // });

        connectButton.addEventListener('click', function() {
            console.debug('[UI] connectButton click, device?', !!device);
            if (device) {
                device.close().then(onDisconnect);
                device = null;
            } else {
                let filters = [];
                if (serial) {
                    filters.push({ 'serialNumber': serial });
                } else if (vid) {
                    filters.push({ 'vendorId': vid });
                }
                navigator.usb.requestDevice({ 'filters': filters }).then(
                    async selectedDevice => {
                        let interfaces = dfu.findDeviceDfuInterfaces(selectedDevice);
                        if (interfaces.length == 0) {
                            console.log(selectedDevice);
                            setText(statusDisplay, "The selected device does not have any USB DFU interfaces.");
                        } else if (interfaces.length == 1) {
                            await fixInterfaceNames(selectedDevice, interfaces);
                            device = await connect(new dfu.Device(selectedDevice, interfaces[0]));
                            app.no_device = false;
                        } else {
                            await fixInterfaceNames(selectedDevice, interfaces);
                            async function connectToSelectedInterface() {
                                let filteredInterfaceList = interfaces.filter(ifc => ifc.name.includes("0x08000000"))
                                if (filteredInterfaceList.length === 0) {
                                    console.log("No interace with flash address 0x08000000 found.")
                                    setText(statusDisplay, "The selected device does not have a Flash Memory sectiona at address 0x08000000.");
                                } else {
                                    app.no_device = false;
                                    device = await connect(new dfu.Device(selectedDevice,filteredInterfaceList[0]));
                                }
                            }
                            await connectToSelectedInterface();
                        }
                    }
                ).catch(error => {
                    setText(statusDisplay, (error && error.message) ? error.message : String(error));
                });
            }
        });

        // Link button: Prompt user to hold footswitch then select device to fetch & flash JuTron.bin
        if (linkButton) {
            linkButton.addEventListener('click', function() {
                console.debug('[UI] linkButton click');
                // Show prelink dialog requesting user to hold the footswitch
                
                async function performLinkFlow() {
                    console.debug('[UI] performLinkFlow start, device?', !!device);
                    if (device) {
                    // already connected; proceed to flash
                    safeSetDisabled(linkButton, true, 'linkButton');
                    readServerFirmwareFile('firmware/JuTron.bin').then(buffer => {
                        flashFirmwareBuffer(buffer).finally(() => { safeSetDisabled(linkButton, false, 'linkButton'); });
                    }).catch(err => {
                        setText(statusDisplay, 'Failed to load JuTron.bin: ' + err);
                        safeSetDisabled(linkButton, false, 'linkButton');
                    })
                    } else {
                    // Need to request device and connect first
                    let filters = [];
                    if (serial) {
                        filters.push({ 'serialNumber': serial });
                    } else if (vid) {
                        filters.push({ 'vendorId': vid });
                    }
                    navigator.usb.requestDevice({ 'filters': filters }).then(
                        async selectedDevice => {
                            let interfaces = dfu.findDeviceDfuInterfaces(selectedDevice);
                            if (interfaces.length == 0) {
                                setText(statusDisplay, "The selected device does not have any USB DFU interfaces.");
                            } else {
                                await fixInterfaceNames(selectedDevice, interfaces);
                                if (interfaces.length == 1) {
                                    device = await connect(new dfu.Device(selectedDevice, interfaces[0]));
                                    app.no_device = false;
                                } else {
                                    // try to auto-pick flash interface
                                    let filteredInterfaceList = interfaces.filter(ifc => ifc.name.includes("0x08000000"))
                                    if (filteredInterfaceList.length === 0) {
                                        setText(statusDisplay, "The selected device does not have a Flash Memory section at address 0x08000000.");
                                        return;
                                    }
                                    app.no_device = false;
                                    device = await connect(new dfu.Device(selectedDevice, filteredInterfaceList[0]));
                                }

                                // Now fetch firmware and flash
                                safeSetDisabled(linkButton, true, 'linkButton');
                                readServerFirmwareFile('firmware/JuTron.bin').then(buffer => {
                                    flashFirmwareBuffer(buffer).finally(() => { safeSetDisabled(linkButton, false, 'linkButton'); });
                                }).catch(err => {
                                    setText(statusDisplay, 'Failed to load JuTron.bin: ' + err);
                                    safeSetDisabled(linkButton, false, 'linkButton');
                                })
                            }
                        }).catch(error => {
                            setText(statusDisplay, (error && error.message) ? error.message : String(error));
                        });
                    }
                }

                // Trigger the dialog, and call performLinkFlow() in direct response to the user gesture
                if (prelinkDialog && prelinkConfirm && prelinkCancel && typeof prelinkDialog.showModal === 'function') {
                        setText(statusDisplay, 'Hold footswitch until lights turn off, then press Continue.');
                    prelinkDialog.showModal();
                    prelinkConfirm.addEventListener('click', async function prelinkConfirmedHandler() {
                        try { prelinkDialog.close(); } catch (e) {}
                        setText(statusDisplay, '');
                        await performLinkFlow();
                    }, { once: true });
                    prelinkCancel.addEventListener('click', function prelinkCancelHandler() {
                        try { prelinkDialog.close(); } catch (e) {}
                        setText(statusDisplay, 'Link canceled by user.');
                    }, { once: true });
                } else {
                    // Fallback to simple confirm() for unsupported browsers
                    const userConfirmed = confirm("Please press and hold the footswitch on your pedal until the faceplate lights turn off, then press OK to continue.");
                    if (!userConfirmed) { setText(statusDisplay, 'Link canceled by user.'); return; }
                    performLinkFlow();
                }
            });
        }

        async function flashFirmwareBuffer(buffer) {
            console.debug('[DFU] flashFirmwareBuffer called, size:', (buffer && buffer.byteLength) ? buffer.byteLength : buffer);
            if (!device) {
                throw new Error('No device connected');
            }
            setLogContext(downloadLog);
            clearLog(downloadLog);
            try {
                let status = await device.getStatus();
                if (status.state == dfu.dfuERROR) {
                    await device.clearStatus();
                }
            } catch (error) {
                device.logWarning('Failed to clear status');
            }

            try {
                // Start with Erasing phase; device will signal phase changes (Erasing -> Flashing)
                setDFUPhase('Erasing');
                // let the device tell us about phase transitions if it supports the hook
                try { device.onPhaseChange = (phase) => { setDFUPhase(phase); }; } catch (e) {}
                await device.do_download(transferSize, buffer, manifestationTolerant);
                logInfo('Done!');
                setDFUPhase(null);
                try { device.onPhaseChange = null; } catch (e) {}
                // Replace the walkthrough with a concise final message (remove intro lines)
                const walkthroughEl = getEl('#walkthrough');
                if (walkthroughEl) {
                    walkthroughEl.innerHTML = '<div class="final-message"><div class="fade-step">Firmware updated.</div><div class="fade-step delay-1">Enjoy :)</div></div>';
                    walkthroughEl.hidden = false;
                }
                setLogContext(null);
                if (!manifestationTolerant) {
                    device.waitDisconnected(5000).then(
                        dev => {
                            onDisconnect();
                            device = null;
                        },
                        error => {
                            console.log('Device unexpectedly tolerated manifestation.');
                        }
                    );
                }
            } catch (error) {
                logError(error);
                setLogContext(null);
            }
        }

        // detachButton.addEventListener('click', function() {
        //     if (device) {
        //         device.detach().then(
        //             async len => {
        //                 let detached = false;
        //                 try {
        //                     await device.close();
        //                     await device.waitDisconnected(5000);
        //                     detached = true;
        //                 } catch (err) {
        //                     console.log("Detach failed: " + err);
        //                 }

        //                 onDisconnect();
        //                 device = null;
        //                 if (detached) {
        //                     // Wait a few seconds and try reconnecting
        //                     setTimeout(autoConnect, 5000);
        //                 }
        //             },
        //             async error => {
        //                 await device.close();
        //                 onDisconnect(error);
        //                 device = null;
        //             }
        //         );
        //     }
        // });

        // uploadButton.addEventListener('click', async function(event) {
        //     event.preventDefault();
        //     event.stopPropagation();
        //     if (!configForm.checkValidity()) {
        //         configForm.reportValidity();
        //         return false;
        //     }

        //     if (!device || !device.device_.opened) {
        //         onDisconnect();
        //         device = null;
        //     } else {
        //         setLogContext(uploadLog);
        //         clearLog(uploadLog);
        //         try {
        //             let status = await device.getStatus();
        //             if (status.state == dfu.dfuERROR) {
        //                 await device.clearStatus();
        //             }
        //         } catch (error) {
        //             device.logWarning("Failed to clear status");
        //         }

        //         let maxSize = Infinity;
        //         if (!dfuseUploadSizeField.disabled) {
        //             maxSize = parseInt(dfuseUploadSizeField.value);
        //         }

        //         try {
        //             const blob = await device.do_upload(transferSize, maxSize);
        //             saveAs(blob, "firmware.bin");
        //         } catch (error) {
        //             logError(error);
        //         }

        //         setLogContext(null);
        //     }

        //     return false;
        // });
	
        if (bootloaderButton) {
            bootloaderButton.addEventListener('click', async function(event) {
            event.preventDefault();
            event.stopPropagation();
            if (!configForm.checkValidity()) {
                configForm.reportValidity();
                return false;
            }

            if (device && bootloaderFirmwareFile != null) {
                setLogContext(downloadLog);
                clearLog(downloadLog);
                try {
                    let status = await device.getStatus();
                    if (status.state == dfu.dfuERROR) {
                        await device.clearStatus();
                    }
                } catch (error) {
                    device.logWarning("Failed to clear status");
                }
                // start with Erasing; allow device to switch to Flashing via onPhaseChange
                setDFUPhase('Erasing');
                try { device.onPhaseChange = (phase) => { setDFUPhase(phase); }; } catch (e) {}
                await device.do_download(transferSize, bootloaderFirmwareFile, manifestationTolerant).then(
                    () => {
                        logInfo("Done!");
                        setDFUPhase(null);
                        try { device.onPhaseChange = null; } catch (e) {}
                        setLogContext(null);
                        if (!manifestationTolerant) {
                            device.waitDisconnected(5000).then(
                                dev => {
                                    onDisconnect();
                                    device = null;
                                },
                                error => {
                                    // It didn't reset and disconnect for some reason...
                                    console.log("Device unexpectedly tolerated manifestation.");
                                }
                            );
                        }
                    },
                    error => {
                        logError(error);
                        setDFUPhase(null);
                        setLogContext(null);
                    }
                )
            }            
            });
        }

        if (blinkButton) {
            blinkButton.addEventListener('click', async function(event) {
            event.preventDefault();
            event.stopPropagation();
            if (!configForm.checkValidity()) {
                configForm.reportValidity();
                return false;
            }

            if (device && blinkFirmwareFile != null) {
                setLogContext(downloadLog);
                clearLog(downloadLog);
                try {
                    let status = await device.getStatus();
                    if (status.state == dfu.dfuERROR) {
                        await device.clearStatus();
                    }
                } catch (error) {
                    device.logWarning("Failed to clear status");
                }
                setDFUPhase('Erasing');
                try { device.onPhaseChange = (phase) => { setDFUPhase(phase); }; } catch (e) {}
                await device.do_download(transferSize, blinkFirmwareFile, manifestationTolerant).then(
                    () => {
                        logInfo("Done!");
                        setDFUPhase(null);
                        try { device.onPhaseChange = null; } catch (e) {}
                        setLogContext(null);
                        if (!manifestationTolerant) {
                            device.waitDisconnected(5000).then(
                                dev => {
                                    onDisconnect();
                                    device = null;
                                },
                                error => {
                                    // It didn't reset and disconnect for some reason...
                                    console.log("Device unexpectedly tolerated manifestation.");
                                }
                            );
                        }
                    },
                    error => {
                        logError(error);
                        setDFUPhase(null);
                        setLogContext(null);
                    }
                )
            }            
            });
        }


        if (downloadButton) {
            downloadButton.addEventListener('click', async function(event) {
            event.preventDefault();
            event.stopPropagation();
            if (!configForm.checkValidity()) {
                configForm.reportValidity();
                return false;
            }

            if (device && firmwareFile != null) {
                setLogContext(downloadLog);
                clearLog(downloadLog);
                try {
                    let status = await device.getStatus();
                    if (status.state == dfu.dfuERROR) {
                        await device.clearStatus();
                    }
                } catch (error) {
                    device.logWarning("Failed to clear status");
                }
                setDFUPhase('Erasing');
                try { device.onPhaseChange = (phase) => { setDFUPhase(phase); }; } catch (e) {}
                await device.do_download(transferSize, firmwareFile, manifestationTolerant).then(
                    () => {
                        logInfo("Done!");
                        setDFUPhase(null);
                        try { device.onPhaseChange = null; } catch (e) {}
                        setLogContext(null);
                        if (!manifestationTolerant) {
                            device.waitDisconnected(5000).then(
                                dev => {
                                    onDisconnect();
                                    device = null;
                                },
                                error => {
                                    // It didn't reset and disconnect for some reason...
                                    console.log("Device unexpectedly tolerated manifestation.");
                                }
                            );
                        }
                    },
                    error => {
                        logError(error);
                        setDFUPhase(null);
                        setLogContext(null);
                    }
                )
            }

            //return false;
            });
        }

        // Check if WebUSB is available
        if (typeof navigator.usb !== 'undefined') {
            navigator.usb.addEventListener("disconnect", onUnexpectedDisconnect);
            // Try connecting automatically
            if (fromLandingPage) {
                autoConnect(vid, serial);
            }
        } else {
            setText(statusDisplay, 'WebUSB not available.')
            safeSetDisabled(connectButton, true, 'connectButton');
        }
    });
})();
