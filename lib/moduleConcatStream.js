const fs = require("fs")
	, path = require("path")
	, Readable = require("stream").Readable
	, resolve = require("resolve");

// Read main header/footer and header/footer for each file in the project
const HEADER = fs.readFileSync(__dirname + "/header.js", {"encoding": "utf8"})
	, FOOTER = fs.readFileSync(__dirname + "/footer.js", {"encoding": "utf8"})
	, FILE_HEADER = fs.readFileSync(__dirname + "/fileHeader.js", {"encoding": "utf8"})
	, FILE_FOOTER = fs.readFileSync(__dirname + "/fileFooter.js", {"encoding": "utf8"});

/* Concatenate all modules within a project.
	The procedure works like this:

	0.) Add a special header file to the stream.  See `./lib/header.js` for
		details.
	1.) Read the entry module, as specified by its path.
	2.) Scan the file for `require("...")` or `require('...')` statements.
		Note: Dynamic require statements such as `require("./" + b)` are not
			matched.
	3.) If the fixed path specified by the `require("...")` statement is a
		relative or absolute filesystem path (i.e. it begins with "./", "../",
		or "/"), then that file is added to the project and recursively scanned
		for `require` statements as in step #2.  Additionally, the file is given
		an unique identifier, and the `require("...")` statement is replaced
		with `__require(id)` where `id` is the unique identifier.  `__require`
		is explained in more detail in `./lib/header.js`.
	4.) In addition, if `outputPath` is specified, any reference to `__dirname`
		or `__filename` is replaced with `__getDirname(...)` and
		`__getFilename(...)`, which are explained in `./lib/header.js`.

		Note: __dirname and __filename references are replaced with paths
			relative to the `outputPath` at the time of concatenation.
			Therefore, if you move `outputPath` to a different path, the
			__dirname and __filename reference will also change, but it will
			still be the relative path at the time of concatenation.  If you
			don't know what I mean and you are having issues, please just read
			./lib/header.js and look at the contents of the `outputPath`.
	5.) Finally, the modified file is wrapped with a header and footer to
		encapsulate the module within its own function.  Then, it is written to
		the stream.
	6.) Once all of the modules are written to the stream, add a special footer
		to the stream.  See `./lib/footer.js` for details.

	Any source file added to the project has:
		- A prepended header (./lib/fileHeader.js)
		- An appended footer (./lib/fileFooter.js)
		- Certain `require` statements replaced with `__require`
		- All `__dirname` and `__filename` references replaced with
			`__getDirname(...)` and `__getFilename(...)` references if
			`outputPath` is specified.

	Known limitations:
		- Dynamic `require()` statements don't work
			(i.e. `require("./" + variable)`)
		- `require.resolve` calls are not modified
		- `require.cache` statements are not modified

API
---
`new ModuleConcatStream(entryModulePath, options)`
	Constructs a Readable stream of the concatenated project.
- `entryModulePath` - the path to the entry point of the project to be
	concatenated.  This might be an `index.js` file, for example.
- `options` - object to specify any of the following options
	- `outputPath` - the path where the concatenated project file will be
		written.  Provide this whenever possible to ensure that instances
		of `__dirname` and `__filename` are replaced properly.  If
		`__dirname` and `__filename` are not used in your project or your
		project dependencies, it is not necessary to provide this path.
	- `excludeFiles` - An Array of files that should be excluded from the
		project even if they were referenced by a `require(...)`.

		Note: These `require` statements should probably be wrapped with a
		conditional or a try/catch block to prevent uncaught exceptions.
	- `excludeNodeModules` - Set to `true` if modules loaded from
		`node_modules` folders should be excluded from the project.
	- `browser` - Set to `true` when concatenating this project for the
		browser.  In this case, whenever a required library is loaded from
		`node_modules`, the `browser` field in the `package.json` file (if
		found) is used to determine which file to actually include in the
		project.

	See README.md for more details.
*/
class ModuleConcatStream extends Readable {
	constructor(entryModulePath, options) {
		// Pass Readable options to the super constructor
		super(options);
		// Save options
		let opts = this._options = options || {};
		// Ensure that all paths have been resolved
		if(opts.excludeFiles) {
			for(var i = 0; i < opts.excludeFiles.length; i++) {
				opts.excludeFiles[i] = path.resolve(opts.excludeFiles[i]);
			}
		}
		// List of files already included in the project or pending inclusion
		this._files = [entryModulePath];
		// Index pointing to the next file to included in the project
		this._fileIndex = 0;
		// List of native C/C++ add-ons found that were excluded from the output
		this._addonsExcluded = [];
		// Flag indicating that the header has been written
		this._headerWritten = false;
	}

	// Called when we should start/continue processing
	_read(size) {
		this._continueProcessing();
	}

	_continueProcessing() {
		// Write the project header
		if(!this._headerWritten) {
			this._headerWritten = true;
			if(!this.push(HEADER) )
				return;
		}
		// Write the next file in the project
		while(this._fileIndex < this._files.length) {
			if(!this._addFile(this._files[this._fileIndex]) )
				return;
		}
		// Write the project footer
		this.push(FOOTER);
		// Write EOF
		this.push(null);
	}

	/* Adds the file from the given `filePath` to the project.  Returns `true`
		if more data can be added to the stream; `false` otherwise. */
	_addFile(filePath) {
		try {
			// Read the file synchronously from disk
			let code = fs.readFileSync(filePath, {"encoding": "utf8"});
			// Mark this file as included in the project
			this._fileIndex++;
			// Remove some line comments from code
			code = code.replace(/(?:\r\n?|\n)\s*\/\/.*/g, "");
			/* Scan file for `require(...)`, `__dirname`, and `__filename`
				Quick notes about the somewhat intense `requireRegex`:
				- require('...') and require("...") is matched
					- The single or double quote matched is group 1
				- Whitespace can go anywhere
				- The module path matched is group 2
				- Backslashes are allowed as escape characters only if followed
					by another backlash (to support Windows paths)
			*/
			var requireRegex = /require\s*\(\s*(["'])((?:(?:(?!\1)[^\\]|(?:\\\\)))*)\1\s*\)/g,
				dirnameRegex = /__dirname/g,
				filenameRegex = /__filename/g;
			// Modify `code` by replacing some `require(...)` calls
			code = code.replace(requireRegex, (match, quote, modulePath) => {
				/* Do not replace core modules, but we'll try to do so if
					`browser` flag is set */
				if(resolve.isCore(modulePath) && this._options.browser !== true)
				{
					return match;
				}
				// Un-escape backslashes in the path by replacing "\\" with "\"
				modulePath = modulePath.replace("\\\\", "\\");
				/* Prevent including modules in `node_modules` if option is
					set.  Check to see if this require path doesn't begin
					with "./" or "../" or "/"
				*/
				if(this._options.excludeNodeModules &&
					modulePath.match(/^\.?\.?\//) == null)
				{
					return match;
				}
				// Get ready to resolve the module
				var resolveOpts = {
					"basedir": path.dirname(filePath),
					"extensions": ["", ".js", ".json", ".node"]
				};
				/* Use package.json `browser` field instead of `main` if
					`browser` option is set */
				if(this._options.browser) {
					resolveOpts.packageFilter = (parsedPkgJson, pkgPath) => {
						if(parsedPkgJson.browser) {
							parsedPkgJson.main = parsedPkgJson.browser;
						}
						return parsedPkgJson;
					};
				}
				// Thank you, node-resolve for making this easy!
				try {
					// Resolve the module path
					modulePath = resolve.sync(modulePath, resolveOpts);
					// Do not replace core modules
					if(resolve.isCore(modulePath) ) {
						return match;
					}
					// If this is a native module, abort
					if(path.extname(modulePath).toLowerCase() === ".node") {
						// This is a native module; do not replace
						this._addonsExcluded.push(modulePath);
						return match;
					}
					// Lookup this module's ID
					var index = this._files.indexOf(modulePath);
					if(index < 0) {
						// Not found; add this module to the project
						if(!this._options.excludeFiles ||
							this._options.excludeFiles.indexOf(modulePath) < 0)
						{
							index = this._files.push(modulePath) - 1;
						}
						else {
							// File is excluded; do not replace
							return match;
						}
					}
					// Replace the `require` statement with `__require`
					var parentIndex = this._files.indexOf(filePath);
					return "__require(" + index + "," + parentIndex + ")";
				} catch(e) {
					// Could not resolve module path; do not replace
					return match;
				}
			});
			// Handle `__dirname` and `__filename` replacement
			if(this._options.outputPath && this._options.browser !== true) {
				let outputPath = this._options.outputPath;
				code = code
					// Replace `__dirname` with `__getDirname(...)`
					.replace(dirnameRegex, "__getDirname(" + JSON.stringify(
						path.relative(path.dirname(outputPath), filePath)
						) + ")")
					// Replace `__filename` with `__getFilename(...)`
					.replace(filenameRegex, "__getFilename(" + JSON.stringify(
						path.relative(path.dirname(outputPath), filePath)
						) + ")");
			}
			/* Prepend module header and append module footer and write the
				included module to the stream */
			return this.push(
				// Add file header
				FILE_HEADER
					.replace(/\$\{id\}/g, this._files.indexOf(filePath) )
					.replace(/\$\{path\}/g, filePath) +
				// Add extra header bit if this is a JSON file
				(path.extname(filePath) === ".json" ?
					"module.exports = " : "") +
				// Add modified project file
				code +
				// Add file footer
				FILE_FOOTER
					.replace(/\$\{id\}/g, this._files.indexOf(filePath) )
					.replace(/\$\{path\}/g, filePath)
			);
		} catch(err) {
			process.nextTick(() => {
				this.emit("error", err);
			});
			return false;
		}
	}

	getStats() {
		if(this._fileIndex < this._files.length) {
			throw new Error("Statistics are not yet available.");
		} else {
			return {
				"files": this._files,
				"addonsExcluded": this._addonsExcluded
			};
		}
	}
}

module.exports = ModuleConcatStream;