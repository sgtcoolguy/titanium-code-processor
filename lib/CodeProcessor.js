/**
 * <p>Copyright (c) 2012 by Appcelerator, Inc. All Rights Reserved.
 * Please see the LICENSE file for information about licensing.</p>
 *
 * WARNING: The Code Processor IS NOT reentrant! A second invokation of the code processor prior to the first
 * one finishing will kill the first instance and the second invokation may be unstable. A second invokation of the code
 * processor after the first has finished is untested and not likely to work.
 *
 * @module CodeProcessor
 * @author Bryan Hughes &lt;<a href='mailto:bhughes@appcelerator.com'>bhughes@appcelerator.com</a>&gt;
 */

// ******** Globals ********

var path = require('path'),
	fs = require('fs'),
	async = require('async'),
	existsSync = fs.existsSync || path.existsSync,

	wrench = require('wrench'),
	uglify = require('uglify-js'),
	mu = require('mu2'),
	sourcemap = require('source-map'),

	RuleProcessor = require('./RuleProcessor'),
	AST = require('./AST'),
	Base = require('./Base'),
	Runtime = require('./Runtime'),
	CodeProcessorUtils = require('./CodeProcessorUtils'),

	pluralize = CodeProcessorUtils.pluralize,

	startTime = Date.now();

// ******** Prime the rules ********
(function(){
	var rules = CodeProcessorUtils.findJavaScriptFiles(path.join(__dirname, 'rules')),
		i,
		len = rules.length;
	for (i = 0; i < len; i++) {
		require(rules[i]);
	}
})();

// ******** Put the lib dir in the global space so modules can use it ********

global.titaniumCodeProcessorLibDir = __dirname;

// ******** Event Documentation ********

/**
 * Indicates that a file is about to be processed.
 *
 * @name module:CodeProcessor.enteredFile
 * @event
 * @property {String} filename The absolute path to the file that is about to be processed
 * @see module:Runtime.on
 */

/**
 * Indicates that the current run of the project is about to be processed
 *
 * @name module:CodeProcessor.projectProcessingBegin
 * @event
 * @see module:Runtime.on
 */

/**
 * Indicates that the current run of the project has finished being processed
 *
 * @name module:CodeProcessor.projectProcessingEnd
 * @event
 * @see module:Runtime.on
 */

// ******** API Methods ********

/**
 * Queries a set of plugin search paths for plugins and their options
 *
 * @method
 * @param {Array[Strings]} paths An array of paths to search in addition to the default path. Can be an empty array, but must not be undefined
 * @param {Function(err, results)} callback The callback to call when finished
 */
exports.queryPlugins = queryPlugins;
function queryPlugins(pluginPaths, logger, callback) {
	var pluginResolutionTasks = [],
		pluginInfo = {};
	pluginPaths = [path.resolve(path.join(__dirname, '..', 'plugins'))].concat(pluginPaths),

	pluginPaths.forEach(function (pluginPath) {
		pluginResolutionTasks.push(function (next) {
			next(undefined, CodeProcessorUtils.getSubDirectories(pluginPath));
		});
	});

	async.parallel(pluginResolutionTasks, function (err, results) {
		if (err) {
			callback(err);
		} else {
			var pluginDirectories = [],
				i, len,
				pluginParseTasks = [];
			for (i = 0, len = results.length; i < len; i++) {
				pluginDirectories = pluginDirectories.concat(results[i]);
			}
			pluginDirectories.forEach(function (pluginDirectory) {
				pluginParseTasks.push(function (next) {
					fs.readFile(path.join(pluginDirectory, 'package.json'), 'utf-8', function (err, data) {
						var pluginData;
						if (err) {
							logger.warn('warn: Could not read plugin information in "' + pluginDirectory + '": ' + err);
							next();
						} else {
							try {
								pluginData = JSON.parse(data);
								if (pluginData.titaniumCodeProcessorPlugin === true) {
									pluginData.path = pluginDirectory;
									pluginInfo[pluginData.name] = pluginData;
								}
							} catch(e) {
								logger.warn('warn: Could not parse plugin information in "' + pluginDirectory + '": ' + e);
							}
							next();
						}
					});
				});
			});
			async.parallel(pluginParseTasks, function () {
				callback(undefined, pluginInfo);
			});
		}
	});
}

/**
 * Queries the set of options
 *
 * @method
 * @param {Function(err, results)} callback The callback to call when finished
 */
exports.queryOptions = queryOptions;
function queryOptions(callback) {
	callback(undefined, {
		invokeMethods: {
			description: 'Whether or not methods should be invoked',
			types: [{
				type: 'boolean'
			}],
			defaultValue: Runtime.options.invokeMethods,
			required: false
		},
		evaluateLoops: {
			description: 'Whether or not to evaluate loops',
			types: [{
				type: 'boolean'
			}],
			defaultValue: Runtime.options.evaluateLoops,
			required: false
		},
		maxLoopIterations: {
			description: 'The maximum number of iterations a loop can iterate before falling back to an unknown evaluation',
			types: [{
				type: 'number'
			}],
			defaultValue: Runtime.options.maxLoopIterations,
			required: false
		},
		maxRecursionLimit: {
			description: 'The maximum recursion depth to evaluate before throwing a RangeError exception',
			types: [{
				type: 'number'
			}],
			defaultValue: Runtime.options.maxRecursionLimit,
			required: false
		},
		logConsoleCalls: {
			description: 'If enabled, all console.* calls in a user\'s code are logged to the terminal',
			types: [{
				type: 'boolean'
			}],
			defaultValue: Runtime.options.logConsoleCalls,
			required: false
		},
		executionTimeLimit: {
			description: 'The maximum time the app is allowed to run before erroring. 0 means no time limit',
			types: [{
				type: 'number'
			}],
			defaultValue: Runtime.options.executionTimeLimit,
			required: false
		},
		exactMode: {
			description: 'whether or not the app should be evaluated in exact mode. Exact mode does not use ambiguous' +
				' modes and throws an exception if an Unknown type is encountered',
			types: [{
				type: 'boolean'
			}],
			defaultValue: Runtime.options.exactMode,
			required: false
		},
		nativeExceptionRecovery: {
			description: 'whether or not to try and recover from recoverable native exceptions when not in try/catch statements',
			types: [{
				type: 'boolean'
			}],
			defaultValue: Runtime.options.nativeExceptionRecovery,
			required: false
		},
		processUnvisitedCode: {
			description: 'When set to true, all nodes and files that are not visited/skipped will be processed in ambiguous' +
				' mode after all other code has been processed. While this will cause more of a project to be analyzed,' +
				' this will decrease accuracy and can generate a lot of false positives',
			types: [{
				type: 'boolean'
			}],
			defaultValue: Runtime.options.processUnvisitedCode,
			required: false
		},
		cycleDetectionStackSize: {
			description: 'The size of the cycle detection stack. Cycles that are larger than this size will not be caught',
			types: [{
				type: 'number'
			}],
			defaultValue: Runtime.options.cycleDetectionStackSize,
			required: false
		},
		maxCycles: {
			description: 'The maximum number of cycles to allow before throwing an exception',
			types: [{
				type: 'number'
			}],
			defaultValue: Runtime.options.maxCycles,
			require: false
		}
	});
}

/**
 * Processes the entry point using the supplied options and plugins
 *
 * @method
 * @param {Object} sourceInformation The source information for the project
 * @param {String} sourceInformation.entryPoint The entry point of the project
 * @param {String} sourceInformation.sourceDir The directory containi
 * @param {Object} options The options for the run. Run {@link queryOptions} for information about the options
 * @param {Any} options.option An option. The actual key is the name of the option
 * @param {Object} plugins The options for the run. Run {@link queryOptions} for information about the options
 * @param {Object} plugins.plugin The plugin. The key is the name of the plugin
 * @param {String} plugins.plugin.path The path to the plugin, as reported by {@link queryOptions}
 * @param {Object} plugins.plugin.options The options for the plugin
 * @param {Any} plugins.plugin.options.option An option. The actual key is the name of the option
 * @param {Winston Logger} [logger] A logger instance from the CLI (can be a CLI logger, which wraps winston, or a winston logger directly)
 */
exports.run = run;
function run(sourceInformation, options, plugins, logger, callback) {

	var results;
	options = options || {};
	plugins = plugins || {};

	try {
		Runtime.setLogger(logger);

		init(sourceInformation, options, plugins);

		Runtime.on('enteredFile', function(e) {
			Runtime.log('debug', 'Entering file ' + e.data.filename);
		});

		Runtime.fireEvent('projectProcessingBegin', 'Project processing is beginning');

		Runtime.log('info', 'Analyzing project');
		results = processEntryPoint(sourceInformation.entryPoint);

		Runtime.log('info', 'Processing queued functions');
		processQueuedFunctions();

		if (Runtime.options.processUnvisitedCode) {
			Runtime.log('info', 'Processing unvisited code');
			processUnvisitedCode();
		}

		finalize();

		Runtime.log('info', 'Generating results');
		Runtime.fireEvent('projectProcessingEnd', 'Project processing complete');
		generateResultsPages(options.outputFormat, Runtime.options.resultsPath, Runtime.options.resultsTheme, callback);
	} catch(e) {
		if (e.message === 'Maximum call stack size exceeded') {
			console.error('node.js maximum call stack size exceeded. Increasing the stack size may allow the project to be fully analyzed');
		} else {
			console.error('Internal error ' + e.message + '. Please file a bug report at http://jira.appcelerator.org/');
			if (e.stack) {
				Runtime.log('debug', e.stack);
			}
		}
		process.exit(1);
	}

	return results;
}

/**
 * Processes the input options
 *
 * @method
 */
exports.init = init;
function init(sourceInformation, options, plugins, ast) {
	var i, ilen, j, jlen, k, klen,
		loadedPlugins = [],
		pkg,
		dependencyFound,
		pluginDefinitions = [],
		pluginDependencyOrder = [],
		unsortedPlugins,
		changed,
		dependencies,
		numPlugins = plugins.length,
		sourceMapDir,
		sourceMapsFiles,
		sourceMaps = {},
		sourceMap,
		sourceMapRegex = /\.map$/;

	// Parse the invoke methods option
	if (options.hasOwnProperty('invokeMethods')) {
		Runtime.options.invokeMethods = !!options.invokeMethods;
	}
	Runtime.log('debug', 'Setting processing option: methods will ' +
		(Runtime.options.invokeMethods ? '' : 'not ') + 'be invoked');

	// Parse the evaluate loops option
	if (options.hasOwnProperty('evaluateLoops')) {
		Runtime.options.evaluateLoops = !!options.evaluateLoops;
	}
	Runtime.log('debug', 'Setting processing option: loops will ' +
		(Runtime.options.evaluateLoops ? '' : 'not ') + 'be evaluated');

	// Parse the max loop iterations option
	if (options.hasOwnProperty('maxLoopIterations')) {
		Runtime.options.maxLoopIterations = parseInt(options.maxLoopIterations, 10);
	}
	Runtime.log('debug', 'Setting processing option: max loop iterations is ' + Runtime.options.maxLoopIterations);

	// Parse the log console calls option
	if (options.hasOwnProperty('logConsoleCalls')) {
		Runtime.options.logConsoleCalls = !!options.logConsoleCalls;
	}
	Runtime.log('debug', 'Setting processing option: console calls will ' +
		(Runtime.options.logConsoleCalls ? '' : 'not ') + 'be logged to the terminal');

	// Parse the execution time limit option
	if (options.hasOwnProperty('executionTimeLimit')) {
		Runtime.options.executionTimeLimit = parseInt(options.executionTimeLimit, 10);
		Runtime.log('debug', 'Setting processing option: execution time limit is ' + Runtime.options.executionTimeLimit);
	}

	// Parse the max recursion limit option
	if (options.hasOwnProperty('maxRecursionLimit')) {
		Runtime.options.maxRecursionLimit = parseInt(options.maxRecursionLimit, 10);
	}
	Runtime.log('debug', 'Setting processing option: max recursion limit is ' + Runtime.options.maxRecursionLimit);

	// Parse the cycle detection stack size option
	if (options.hasOwnProperty('cycleDetectionStackSize')) {
		Runtime.options.cycleDetectionStackSize = parseInt(options.cycleDetectionStackSize, 10);
	}
	Runtime.log('debug', 'Setting processing option: cycle detection stack size is ' + Runtime.options.cycleDetectionStackSize);

	// Parse the max cycles limit option
	if (options.hasOwnProperty('maxCycles')) {
		Runtime.options.maxCycles = parseInt(options.maxCycles, 10);
	}
	Runtime.log('debug', 'Setting processing option: max cycle limit is ' + Runtime.options.maxCycles);

	// Parse the exact mode options
	if (options.hasOwnProperty('exactMode')) {
		Runtime.options.exactMode = !!options.exactMode;
	}
	Runtime.log('debug', 'Setting processing option: exact mode is ' + (Runtime.options.exactMode ? 'on' : 'off'));

	// Parse the process unvisited code option
	if (options.hasOwnProperty('processUnvisitedCode')) {
		Runtime.options.processUnvisitedCode = !!options.processUnvisitedCode;
	}
	Runtime.log('debug', 'Setting processing option: unvisited code will ' +
		(Runtime.options.processUnvisitedCode ? '' : 'not ') + 'be processed');

	// Parse the native exception recovery option
	if (options.hasOwnProperty('nativeExceptionRecovery')) {
		Runtime.options.nativeExceptionRecovery = !!options.nativeExceptionRecovery;
	}
	Runtime.log('debug', 'Setting processing option: native exception recovery is ' +
		(Runtime.options.nativeExceptionRecovery ? 'enabled' : 'disabled'));

	// Parse the resultsPath option
	if (options.hasOwnProperty('resultsPath')) {
		Runtime.options.resultsPath = options.resultsPath;
	}
	Runtime.log('debug', 'Setting processing option: ' + (Runtime.options.resultsPath ? 'the results path is "' +
		Runtime.options.resultsPath + '"' : 'no results path is set'));

	// Parse the resultsTheme option
	if (options.hasOwnProperty('resultsTheme')) {
		Runtime.options.resultsTheme = options.resultsTheme;
	}
	Runtime.log('debug', 'Setting processing option: ' + (Runtime.options.resultsTheme ? 'the results theme is "' +
		Runtime.options.resultsTheme + '"' : 'no results theme is set'));

	// Calculated the time limit
	if (Runtime.options.executionTimeLimit) {
		Runtime.executionTimeLimit = Date.now() + Runtime.options.executionTimeLimit;
	}

	// Load the source maps
	if (sourceInformation && sourceInformation.sourceMapDir) {
		sourceMapDir = sourceInformation.sourceMapDir;
		if (!existsSync(sourceMapDir)) {
			console.error('Source map directory "' + sourceMapDir + '" does not exist');
			process.exit(1);
		}
		sourceMapsFiles = wrench.readdirSyncRecursive(sourceMapDir);
		for (i = 0, ilen = sourceMapsFiles.length; i < ilen; i++) {
			sourceMap = path.join(sourceMapDir, sourceMapsFiles[i]);
			if (sourceMapRegex.test(sourceMap)) {
				try {
					sourceMaps[sourceMapsFiles[i].replace(sourceMapRegex, '')] = new sourcemap.SourceMapConsumer(JSON.parse(fs.readFileSync(sourceMap).toString()));
				} catch (e) {
					console.error('Could not parse source map file "' + sourceMap + '": ' + e.message);
					process.exit(1);
				}
			}
		}
		sourceInformation.sourceMaps = sourceMaps;
	}

	// Initialize the runtime
	Runtime.log('info', 'Initializing core engine');
	Base.createGlobalContext(ast);
	Base.init();
	Runtime.sourceInformation = sourceInformation;

	// Load the plugins
	for (i = 0; i < numPlugins; i++) {
		try {
			pkg = JSON.parse(fs.readFileSync(path.join(plugins[i].path, 'package.json')));
			Runtime.log('debug', 'Loading code processor plugin ' + pkg.name);
			pluginDefinitions[i] = pkg;
		} catch(e) {
			console.error('Could not parse "' + path.join(plugins[i].path, 'package.json') + '": ' + e);
			process.exit(1);
		}
	}
	unsortedPlugins = [].concat(pluginDefinitions);
	while (unsortedPlugins.length) {
		changed = false;
		for (i = 0, ilen = unsortedPlugins.length; i < ilen; i++) {
			dependencies = Object.keys(unsortedPlugins[i].dependencies);
			if (dependencies.length) {
				dependencyFound = dependencies.length;
				for (j = 0, jlen = pluginDependencyOrder.length; j < jlen; j++) {
					for (k = 0, klen = dependencies.length; k < klen; k++) {
						if (pluginDependencyOrder[j].name === dependencies[k]) {
							dependencyFound--;
						}
					}
				}
				if (dependencyFound === 0) {
					changed = true;
					pluginDependencyOrder.push(unsortedPlugins.splice(i, 1)[0]);
					break;
				}
			} else {
				changed = true;
				pluginDependencyOrder.push(unsortedPlugins.splice(i, 1)[0]);
				break;
			}
		}
		if (!changed) {
			console.error('Circular or missing plugin dependency detected, cannot load plugins');
			process.exit(1);
		}
	}
	for (i = 0; i < numPlugins; i++) {
		for (j = 0; j < numPlugins; j++) {
			if (pluginDependencyOrder[i].name === pluginDefinitions[j].name) {
				Runtime.log('debug', 'Initializing plugin ' + pluginDefinitions[j].name);
				dependencies = [];
				for (k = 0; k < numPlugins; k++) {
					if (loadedPlugins[k] && loadedPlugins[k].name in pluginDefinitions[j].dependencies) {
						dependencies.push(loadedPlugins[k]);
					}
				}
				loadedPlugins[j] = require(plugins[j].path);
				loadedPlugins[j].name = pluginDefinitions[j].name;
				loadedPlugins[j].displayName = pluginDefinitions[j].displayName;
				if (loadedPlugins[j].init) {
					loadedPlugins[j].init(plugins[j].options, dependencies);
				}
				break;
			}
		}
	}
	Runtime.plugins = loadedPlugins;

	// Calculate the list of viable files
	if (sourceInformation) {
		Runtime.fileList = CodeProcessorUtils.findJavaScriptFiles(sourceInformation.sourceDir);
	}
	Runtime.fireEvent('fileListSet', 'The list of files in the project was set', {
		fileList: Runtime.fileList
	});
}

/**
 * Finalizes the state of the code processor
 *
 * @method
 */
exports.finalize = finalize;
function finalize() {
	var id,
		astSet = Runtime.getASTSet(),
		ambiguousBlockSemaphoreStack = [0],
		ambiguousContextSemaphoreStack = [false],
		unknownSemaphoreStack = [0];

	// Exit the global context
	Runtime.exitContext();

	// Mark all ambiguous blocks and contexts as ambiguous
	function nodeCallback(node, descend) {
		var isFunction = node instanceof uglify.AST_Defun || node instanceof uglify.AST_Function,
			currentStackLocation,
			taggedAsAmbiguousContext = node._ambiguousContext,
			taggedAsAmbiguousBlock = node._ambiguousBlock,
			taggedAsUnknown = node._unknown;
		if (isFunction) {
			ambiguousBlockSemaphoreStack.push(0);
			ambiguousContextSemaphoreStack.push(0);
			unknownSemaphoreStack.push(0);
		}
		currentStackLocation = ambiguousContextSemaphoreStack.length - 1;
		if (taggedAsAmbiguousBlock ) {
			ambiguousBlockSemaphoreStack[currentStackLocation]++;
		}
		if (taggedAsAmbiguousContext) {
			ambiguousContextSemaphoreStack[currentStackLocation]++;
		}
		if (taggedAsUnknown) {
			unknownSemaphoreStack[currentStackLocation]++;
		}

		if (ambiguousBlockSemaphoreStack[currentStackLocation]) {
			node._ambiguousBlock = true;
		}
		if (ambiguousContextSemaphoreStack[currentStackLocation]) {
			node._ambiguousContext = true;
		}
		if (unknownSemaphoreStack[currentStackLocation]) {
			node._unknown = true;
		}

		descend();

		if (taggedAsAmbiguousBlock ) {
			ambiguousBlockSemaphoreStack[currentStackLocation]--;
		}
		if (taggedAsAmbiguousContext) {
			ambiguousContextSemaphoreStack[currentStackLocation]--;
		}
		if (taggedAsUnknown) {
			unknownSemaphoreStack[currentStackLocation]--;
		}
		if (isFunction) {
			ambiguousBlockSemaphoreStack.pop();
			ambiguousContextSemaphoreStack.pop();
		}
		return true;
	}
	for (id in astSet) {
		astSet[id].walk(new uglify.TreeWalker(nodeCallback));
	}
}

/**
 * @private
 */
function processException(exception) {
	if (Base.type(exception) === 'String') {
		exception = exception.value;
	} else if (Base.type(exception) === 'Unknown') {
		exception = '<unknown>';
	} else {
		exception = exception._lookupProperty('message').value;
		if (Base.type(exception) === 'Unknown') {
			exception = '<unknown>';
		} else {
			exception = exception.value;
		}
	}
	return exception;
}

/**
 * Processes the input options
 *
 * @method
 */
exports.processEntryPoint = processEntryPoint;
function processEntryPoint(entryPoint) {

	var ast,
		results;

	// Process the project
	try {
		/*jshint debug: true*/
		debugger;

		// Make sure the entryPoint exists
		if (existsSync(entryPoint)) {

			// Fire the parsing begin event
			Runtime.fireEvent('enteredFile', 'Entering file "' + entryPoint + '"', {
				filename: entryPoint
			});

			// Read in the entryPoint and generate the AST
			ast = AST.parse(entryPoint);
			if (!ast.syntaxError) {
				Runtime._unknown = false;
				Base.createModuleContext(ast, RuleProcessor.isBlockStrict(ast), false, false);
				try {
					results = ast.processRule();
				} finally {
					Runtime.exitContext();
				}
			} else {
				Runtime.reportUglifyError(ast);
			}

		} else {
			throw new Error('Internal Error: could not find file "' + entryPoint + '"');
		}

		// Check if an exception was thrown
		if (results && results[0] === 'throw') {
			Runtime.reportError('uncaughtException', processException(results[1]._exception));
		}
	} catch (e) {
		if (e.isCodeProcessorException) {
			results = ['throw', Runtime._exception, undefined];
			Runtime.reportError('uncaughtException', processException(Runtime._exception));
			Runtime._exception = undefined;
		} else {
			throw e;
		}
	}

	return results;
}

/**
 * Processes the input options
 *
 * @method
 */
exports.processQueuedFunctions = processQueuedFunctions;
function processQueuedFunctions() {

	var queuedFunction;

	// Process any queued functions
	while (queuedFunction = Runtime.getNextQueuedFunction()) {

		Runtime.log('debug', 'Evaluating queued function at ' + queuedFunction.filename + ':' + queuedFunction.line);
		Runtime.recursionCount++;
		try {
			queuedFunction.func.callFunction(queuedFunction.thisVal, queuedFunction.args, {
				isAmbiguousContext: queuedFunction.ambiguousContext
			});
		} catch (e) {
			if (e.isCodeProcessorException) {
				Runtime.reportError('uncaughtException', processException(Runtime._exception));
				Runtime._exception = undefined;
			} else {
				throw e;
			}
		} finally {
			Runtime.recursionCount--;
		}
	}
}

/**
 * Processes the input options
 *
 * @method
 */
exports.processUnvisitedCode = processUnvisitedCode;
function processUnvisitedCode() {
	var unprocessedFile,
		unprocessedFunction,
		ast,
		funcObject,
		args,
		i,
		previousAmbiguousSetting;

	while (unprocessedFile = Runtime.getUnprocessedFilesList()[0]) {

		Runtime.log('debug', 'Processing unprocessed file ' + unprocessedFile);

		// Fire the parsing begin event
		Runtime.fireEvent('enteredFile', 'Entering file "' + unprocessedFile + '"', {
			filename: unprocessedFile
		});

		// Read in the entryPoint and generate the AST
		ast = AST.parse(unprocessedFile);
		if (!ast.syntaxError) {

			// Create the module context
			Base.createModuleContext(ast, RuleProcessor.isBlockStrict(ast), true, true);

			// Process the code
			Runtime._unknown = false;
			try {
				ast.processRule();
			} catch (e) {
				if (e.isCodeProcessorException) {
					Runtime.reportError('uncaughtException', processException(Runtime._exception));
					Runtime._exception = undefined;
				} else {
					throw e;
				}
			} finally {
				// Exit the module context
				Runtime.exitContext();
			}
		} else {
			Runtime.reportUglifyError(ast);
		}
	}

	Runtime.log('debug', 'Processing unvisited functions');
	while (unprocessedFunction = Runtime.getNextUnprocessedFunction()) {

		Runtime.log('debug', 'Evaluating unprocessed function at ' + unprocessedFunction.start.file + ':' + unprocessedFunction.start.line);

		unprocessedFunction._lastKnownContext._ambiguousContext = true;
		Runtime.enterContext(unprocessedFunction._lastKnownContext);

		// Function definitions are instantiated as part of identifier binding in the context creation, but function exrpessions are not
		if (unprocessedFunction.className === 'AST_Defun') {
			funcObject = unprocessedFunction._funcObject;
		} else {
			funcObject = unprocessedFunction.processRule();
		}

		// Create unknown arguments set to the length of the expected args
		args = [];
		for (i = 0; i < funcObject.formalParameters.length; i++) {
			args.push(new Base.UnknownType());
		}

		Runtime.recursionCount++;
		try {
			funcObject.callFunction(new Base.UnknownType(), args, {
				isAmbiguousContext: true,
				alwaysInvoke: true
			});
		} catch (e) {
			if (e.isCodeProcessorException) {
				Runtime.reportError('uncaughtException', processException(Runtime._exception));
				Runtime._exception = undefined;
			} else {
				throw e;
			}
		} finally {
			Runtime.recursionCount--;
			Runtime.exitContext();
		}

		unprocessedFunction._lastKnownContext._ambiguousContext = previousAmbiguousSetting;
	}
}

/**
 * Gets the results of the code processor. Note: the results are sanitized to remove hidden properties and functions,
 * thus allowing the results to be JSON.stringify()'d.
 *
 * @method
 * @returns {Object} An object containing three entries: 'errors', 'warnings', and 'plugins'. The plugins entry is
 *		itself an object, with the keys being the names of each plugin.
 */
exports.getResults = getResults;
function getResults() {
	var errors = Runtime.getReportedErrors(),
		warnings = Runtime.getReportedWarnings(),
		rawResults = {
			errors: errors,
			warnings: warnings,
			plugins: [],
			elapsedTime: Date.now() - startTime,
			resultsPath: Runtime.options.resultsPath
		},
		results = {},
		i, len,
		hiddenRegex = /^_/,
		astNode = uglify.AST_Node;
	for (i = 0, len = Runtime.plugins.length; i < len; i++) {
		rawResults.plugins[i] = Runtime.plugins[i].getResults && Runtime.plugins[i].getResults() || {};
		rawResults.plugins[i].name = Runtime.plugins[i].name;
	}
	for (i = 0, len = errors.length; i < len; i++) {
		if (errors[i].occurances > 1) {
			errors[i].description += ' (' + errors[i].occurances + ' occurances)';
		}
	}
	for (i = 0, len = warnings.length; i < len; i++) {
		if (warnings[i].occurances > 1) {
			warnings[i].description += ' (' + warnings[i].occurances + ' occurances)';
		}
	}
	function sanitize(rawNode, node) {
		var p;
		for (p in rawNode) {
			if (!hiddenRegex.test(p) && !(rawNode[p] instanceof astNode)) {
				if (typeof rawNode[p] === 'object') {
					node[p] = Array.isArray(rawNode[p]) ? [] : {};
					sanitize(rawNode[p], node[p]);
				} else if (typeof rawNode[p] !== 'function') {
					node[p] = rawNode[p];
				}
			}
		}
	}
	sanitize(rawResults, results);
	return results;
}

// ******** Helper Methods ********

function generateResultsPages(outputFormat, resultsDirectory, theme, callback) {
	var plugins = Runtime.plugins,
		results = getResults(),
		header = [],
		i, len,
		currentPage,
		tasks = [],
		errorList,
		error,
		warningList,
		warning,
		pluginList,
		elevatedPluginList,
		plugin,
		page,
		numErrors,
		numWarnings,
		errorsAndWarnings,
		baseDirectory = Runtime.sourceInformation.projectDir + path.sep,
		resultsToLog = '',
		data,
		paddingLength,
		mappedLocation;

	function queueRender(template, destination, headerIndex, data) {
		tasks.push(function(next){
			var renderStream,
				i, len,
				compiledData = '';

			if (!existsSync(template)) {
				throw new Error('Template "' + template + '" does not exist');
			}

			for (i = 0, len = header.length; i < len; i++) {
				header[i].isHighlighted = i === headerIndex;
			}
			data.header = header;

			mu.root = path.dirname(template);
			renderStream = mu.compileAndRender(path.basename(template), data);
			renderStream.on('data', function (data) {
				compiledData += data.toString();
			});
			renderStream.on('end', function() {
				fs.writeFile(destination, compiledData, function () {
					next();
				});
			});
		});
	}

	function nChars(n, chr) {
		var spaces = '',
			i;
		for (i = 0; i < n; i++) {
			spaces += chr;
		}
		return spaces;
	}

	function arrayGen(headings, entries, entriesOrder) {
		var columns = new Array(headings.length),
			i, ilen, j, jlen,
			maxLength,
			entry,
			topSep,
			middleSep,
			bottomSep,
			padding,
			output = '';

		// Collate and pad the data
		for (i = 0, ilen = columns.length; i < ilen; i++) {
			columns[i] = [headings[i]];
			maxLength = headings[i].length;
			for (j = 0, jlen = entries.length; j < jlen; j++) {
				entry = (entries[j][entriesOrder[i]]).toString();
				columns[i].push(entry);
				if (entry.length > maxLength) {
					maxLength = entry.length;
				}
			}
			for (j = 0, jlen = columns[i].length; j < jlen; j++) {
				columns[i][j] = ' ' + columns[i][j] + nChars(maxLength - columns[i][j].length + 1, ' ');
			}
		}

		// Generate the table separators
		topSep =    '┌';
		middleSep = '├';
		bottomSep = '└';
		for (i = 0, ilen = columns.length - 1; i < ilen; i++) {
			padding = nChars(columns[i][0].length, '─');
			topSep += padding +    '┬';
			middleSep += padding + '┼';
			bottomSep += padding + '┴';
		}
		padding = nChars(columns[columns.length - 1][0].length, '─');
		topSep += padding +    '┐\n';
		middleSep += padding + '┤\n';
		bottomSep += padding + '┘';

		output += topSep;
		for (i = 0, ilen = columns[0].length; i < ilen; i++) {
			output += '|';
			for (j = 0, jlen = columns.length; j < jlen; j++) {
				output += '' + (i === 0 ? columns[j][i].cyan : columns[j][i]) + '|';
			}
			output += '\n' + (i < ilen - 1 ? middleSep : bottomSep);
		}

		return output;
	}

	// Generate the errors and warnings lists
	if (results.errors.length) {
		errorList = [];
		for (i = 0, len = results.errors.length; i < len; i++) {
			error = results.errors[i];
			mappedLocation = Runtime.mapLocation(error);
			errorList.push({
				description: error.description,
				filename: mappedLocation.filename.replace(baseDirectory, ''),
				line: mappedLocation.line
			});
		}
	}
	if (results.warnings.length) {
		warningList = [];
		for (i = 0, len = results.warnings.length; i < len; i++) {
			warning = results.warnings[i];
			mappedLocation = Runtime.mapLocation(warning);
			warningList.push({
				description: warning.description,
				filename: mappedLocation.filename.replace(baseDirectory, ''),
				line: mappedLocation.line
			});
		}
	}

	// Generate the plugin summary list
	if (plugins.length) {
		pluginList = [];
		elevatedPluginList = [];
		for (i = 0, len = plugins.length; i < len; i++) {
			plugin = plugins[i];
			if (plugin.getResultsPageData) {
				(plugin.elevatePluginSummary ? elevatedPluginList : pluginList).push({
					name: plugin.displayName,
					overview: results.plugins[i].summary || ''
				});
			}
		}
	}

	// Generate the errors and warnings summary
	numErrors = results.errors.length;
	numWarnings = results.warnings.length;
	if (numErrors || numWarnings) {
		errorsAndWarnings = '\n';
		if (numErrors) {
			errorsAndWarnings += pluralize('%s error ', '%s errors ', numErrors);
			if (numWarnings) {
				errorsAndWarnings += 'and ';
			}
		}
		if (numWarnings) {
			errorsAndWarnings += pluralize('%s warning ', '%s warnings ', numWarnings);
		}
		errorsAndWarnings += 'detected';
	}

	data = {
		elapsedTime: (results.elapsedTime / 1000).toFixed(1),
		time: (new Date()).toTimeString(),
		date: (new Date()).toDateString(),
		options: [{
			option: 'Invoke Methods',
			value: Runtime.options.invokeMethods,
		},{
			option: 'Evaluate Loops',
			value: Runtime.options.evaluateLoops,
		},{
			option: 'Process Unvisited Code',
			value: Runtime.options.processUnvisitedCode,
		}],
		errorsAndWarnings: errorsAndWarnings,
		errors: errorList ? { errorList: errorList } : undefined,
		warnings: warningList ? { warningList: warningList } : undefined,
		elevatedPlugins: elevatedPluginList,
		plugins: pluginList ? { pluginList: pluginList } : undefined
	};

	if (outputFormat === 'report') {
		for (i = 0, len = plugins.length; i < len; i++) {
			plugin = plugins[i];
			if (plugin.renderLogOutput) {
				paddingLength = (40 - plugin.displayName.length) / 2;
				resultsToLog += '\n\n' +
					'******************************************\n' +
					'*' + nChars(Math.floor(paddingLength), ' ') + plugin.displayName.cyan + nChars(Math.ceil(paddingLength), ' ') + '*\n' +
					'******************************************\n\n' +
					plugin.renderLogOutput(arrayGen);
			}
		}

		resultsToLog +=
			'\n\n******************************************\n' +
			'*                ' + 'Summary'.cyan + '                 *\n' +
			'******************************************\n\n';

		resultsToLog += 'Analysis completed in ' + data.elapsedTime + ' seconds at ' + data.time + ' on ' + data.date +
			(data.errorsAndWarnings ? data.errorsAndWarnings : '') + '\n';
		if (elevatedPluginList && elevatedPluginList.length) {
			for (i = 0, len = elevatedPluginList.length; i < len; i++) {
				resultsToLog += elevatedPluginList[i].name + ': ' + elevatedPluginList[i].overview + '\n';
			}
		}
		resultsToLog += '\n';

		resultsToLog += 'Options selected\n';
		resultsToLog += arrayGen(['Option', 'Value'], data.options, ['option', 'value']);

		if (data.errors) {
			resultsToLog += '\n\nErrors\n';
			resultsToLog += arrayGen(['Description', 'File', 'Line'], data.errors.errorList, ['description', 'filename', 'line']);
		}
		if (data.warnings) {
			resultsToLog += '\n\nWarnings\n';
			resultsToLog += arrayGen(['Description', 'File', 'Line'], data.warnings.warningList, ['description', 'filename', 'line']);
		}
		if (data.plugins && data.plugins.pluginList.length) {
			resultsToLog += '\n\nPlugin Summary\n';
			resultsToLog += arrayGen(['Plugin', 'Overview'], data.plugins.pluginList, ['name', 'overview']);
		}

		console.log(resultsToLog + '\n');
	} else if (outputFormat === 'json') {
		console.log(JSON.stringify(results, false, '\t'));
	} else if (outputFormat === 'stream') {
		results = JSON.stringify(results);
		console.log('REQ,01000001,' + ('00000000' + results.length.toString(16)).slice(-8) + ',' + results);
	}

	if (resultsDirectory) {

		// Create the results directory if it doesn't exist
		if (!existsSync(resultsDirectory)) {
			wrench.mkdirSyncRecursive(resultsDirectory);
		}

		// Copy the style sheet over
		theme = path.join(__dirname, '..', 'templates', 'bootstrap-' + (theme || 'light'));
		if (!existsSync(theme)) {
			throw new Error('Template theme "' + theme + '" does not exist');
		}
		wrench.copyDirSyncRecursive(theme, path.join(resultsDirectory, 'bootstrap'));

		// Create the header
		for (i = 0, len = plugins.length; i < len; i++) {
			plugin = plugins[i];
			if (plugin.getResultsPageData) {
				header.push({
					name: plugin.displayName,
					file: plugin.name + '.html'
				});
			}
		}

		// Generate the summary results page
		queueRender(path.join(__dirname, '..', 'templates', 'summary.html'),
			path.join(resultsDirectory, 'index.html'), -1, data);

		// Generate the plugin results pages
		currentPage = 0;
		for (i = 0, len = plugins.length; i < len; i++) {
			plugin = plugins[i];
			if (plugin.getResultsPageData) {
				plugin = plugin.getResultsPageData(plugin.name + '.html', baseDirectory);
				for (page in plugin) {
					queueRender(plugin[page].template,
						path.join(resultsDirectory, page),
						currentPage,
						plugin[page].data);
				}
				currentPage++;
			}
		}

		// Render the results
		async.series(tasks, callback);
	} else {
		callback && callback();
	}
}