import { createRequire as __platformCreateRequire } from "node:module"; const require = __platformCreateRequire(import.meta.url);
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __commonJS = (cb, mod) => function __require2() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// scheduler/node_modules/postgres-array/index.js
var require_postgres_array = __commonJS({
  "scheduler/node_modules/postgres-array/index.js"(exports) {
    "use strict";
    exports.parse = function(source, transform) {
      return new ArrayParser(source, transform).parse();
    };
    var ArrayParser = class _ArrayParser {
      constructor(source, transform) {
        this.source = source;
        this.transform = transform || identity;
        this.position = 0;
        this.entries = [];
        this.recorded = [];
        this.dimension = 0;
      }
      isEof() {
        return this.position >= this.source.length;
      }
      nextCharacter() {
        var character = this.source[this.position++];
        if (character === "\\") {
          return {
            value: this.source[this.position++],
            escaped: true
          };
        }
        return {
          value: character,
          escaped: false
        };
      }
      record(character) {
        this.recorded.push(character);
      }
      newEntry(includeEmpty) {
        var entry;
        if (this.recorded.length > 0 || includeEmpty) {
          entry = this.recorded.join("");
          if (entry === "NULL" && !includeEmpty) {
            entry = null;
          }
          if (entry !== null) entry = this.transform(entry);
          this.entries.push(entry);
          this.recorded = [];
        }
      }
      consumeDimensions() {
        if (this.source[0] === "[") {
          while (!this.isEof()) {
            var char = this.nextCharacter();
            if (char.value === "=") break;
          }
        }
      }
      parse(nested) {
        var character, parser, quote;
        this.consumeDimensions();
        while (!this.isEof()) {
          character = this.nextCharacter();
          if (character.value === "{" && !quote) {
            this.dimension++;
            if (this.dimension > 1) {
              parser = new _ArrayParser(this.source.substr(this.position - 1), this.transform);
              this.entries.push(parser.parse(true));
              this.position += parser.position - 2;
            }
          } else if (character.value === "}" && !quote) {
            this.dimension--;
            if (!this.dimension) {
              this.newEntry();
              if (nested) return this.entries;
            }
          } else if (character.value === '"' && !character.escaped) {
            if (quote) this.newEntry(true);
            quote = !quote;
          } else if (character.value === "," && !quote) {
            this.newEntry();
          } else {
            this.record(character.value);
          }
        }
        if (this.dimension !== 0) {
          throw new Error("array dimension not balanced");
        }
        return this.entries;
      }
    };
    function identity(value) {
      return value;
    }
  }
});

// scheduler/node_modules/pg-types/lib/arrayParser.js
var require_arrayParser = __commonJS({
  "scheduler/node_modules/pg-types/lib/arrayParser.js"(exports, module) {
    var array = require_postgres_array();
    module.exports = {
      create: function(source, transform) {
        return {
          parse: function() {
            return array.parse(source, transform);
          }
        };
      }
    };
  }
});

// scheduler/node_modules/postgres-date/index.js
var require_postgres_date = __commonJS({
  "scheduler/node_modules/postgres-date/index.js"(exports, module) {
    "use strict";
    var DATE_TIME = /(\d{1,})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(\.\d{1,})?.*?( BC)?$/;
    var DATE = /^(\d{1,})-(\d{2})-(\d{2})( BC)?$/;
    var TIME_ZONE = /([Z+-])(\d{2})?:?(\d{2})?:?(\d{2})?/;
    var INFINITY = /^-?infinity$/;
    module.exports = function parseDate(isoDate) {
      if (INFINITY.test(isoDate)) {
        return Number(isoDate.replace("i", "I"));
      }
      var matches = DATE_TIME.exec(isoDate);
      if (!matches) {
        return getDate(isoDate) || null;
      }
      var isBC = !!matches[8];
      var year = parseInt(matches[1], 10);
      if (isBC) {
        year = bcYearToNegativeYear(year);
      }
      var month = parseInt(matches[2], 10) - 1;
      var day = matches[3];
      var hour = parseInt(matches[4], 10);
      var minute = parseInt(matches[5], 10);
      var second = parseInt(matches[6], 10);
      var ms = matches[7];
      ms = ms ? 1e3 * parseFloat(ms) : 0;
      var date;
      var offset = timeZoneOffset(isoDate);
      if (offset != null) {
        date = new Date(Date.UTC(year, month, day, hour, minute, second, ms));
        if (is0To99(year)) {
          date.setUTCFullYear(year);
        }
        if (offset !== 0) {
          date.setTime(date.getTime() - offset);
        }
      } else {
        date = new Date(year, month, day, hour, minute, second, ms);
        if (is0To99(year)) {
          date.setFullYear(year);
        }
      }
      return date;
    };
    function getDate(isoDate) {
      var matches = DATE.exec(isoDate);
      if (!matches) {
        return;
      }
      var year = parseInt(matches[1], 10);
      var isBC = !!matches[4];
      if (isBC) {
        year = bcYearToNegativeYear(year);
      }
      var month = parseInt(matches[2], 10) - 1;
      var day = matches[3];
      var date = new Date(year, month, day);
      if (is0To99(year)) {
        date.setFullYear(year);
      }
      return date;
    }
    function timeZoneOffset(isoDate) {
      if (isoDate.endsWith("+00")) {
        return 0;
      }
      var zone = TIME_ZONE.exec(isoDate.split(" ")[1]);
      if (!zone) return;
      var type = zone[1];
      if (type === "Z") {
        return 0;
      }
      var sign2 = type === "-" ? -1 : 1;
      var offset = parseInt(zone[2], 10) * 3600 + parseInt(zone[3] || 0, 10) * 60 + parseInt(zone[4] || 0, 10);
      return offset * sign2 * 1e3;
    }
    function bcYearToNegativeYear(year) {
      return -(year - 1);
    }
    function is0To99(num2) {
      return num2 >= 0 && num2 < 100;
    }
  }
});

// scheduler/node_modules/xtend/mutable.js
var require_mutable = __commonJS({
  "scheduler/node_modules/xtend/mutable.js"(exports, module) {
    module.exports = extend;
    var hasOwnProperty = Object.prototype.hasOwnProperty;
    function extend(target) {
      for (var i = 1; i < arguments.length; i++) {
        var source = arguments[i];
        for (var key in source) {
          if (hasOwnProperty.call(source, key)) {
            target[key] = source[key];
          }
        }
      }
      return target;
    }
  }
});

// scheduler/node_modules/postgres-interval/index.js
var require_postgres_interval = __commonJS({
  "scheduler/node_modules/postgres-interval/index.js"(exports, module) {
    "use strict";
    var extend = require_mutable();
    module.exports = PostgresInterval;
    function PostgresInterval(raw) {
      if (!(this instanceof PostgresInterval)) {
        return new PostgresInterval(raw);
      }
      extend(this, parse(raw));
    }
    var properties = ["seconds", "minutes", "hours", "days", "months", "years"];
    PostgresInterval.prototype.toPostgres = function() {
      var filtered = properties.filter(this.hasOwnProperty, this);
      if (this.milliseconds && filtered.indexOf("seconds") < 0) {
        filtered.push("seconds");
      }
      if (filtered.length === 0) return "0";
      return filtered.map(function(property) {
        var value = this[property] || 0;
        if (property === "seconds" && this.milliseconds) {
          value = (value + this.milliseconds / 1e3).toFixed(6).replace(/\.?0+$/, "");
        }
        return value + " " + property;
      }, this).join(" ");
    };
    var propertiesISOEquivalent = {
      years: "Y",
      months: "M",
      days: "D",
      hours: "H",
      minutes: "M",
      seconds: "S"
    };
    var dateProperties = ["years", "months", "days"];
    var timeProperties = ["hours", "minutes", "seconds"];
    PostgresInterval.prototype.toISOString = PostgresInterval.prototype.toISO = function() {
      var datePart = dateProperties.map(buildProperty, this).join("");
      var timePart = timeProperties.map(buildProperty, this).join("");
      return "P" + datePart + "T" + timePart;
      function buildProperty(property) {
        var value = this[property] || 0;
        if (property === "seconds" && this.milliseconds) {
          value = (value + this.milliseconds / 1e3).toFixed(6).replace(/0+$/, "");
        }
        return value + propertiesISOEquivalent[property];
      }
    };
    var NUMBER = "([+-]?\\d+)";
    var YEAR = NUMBER + "\\s+years?";
    var MONTH = NUMBER + "\\s+mons?";
    var DAY = NUMBER + "\\s+days?";
    var TIME = "([+-])?([\\d]*):(\\d\\d):(\\d\\d)\\.?(\\d{1,6})?";
    var INTERVAL = new RegExp([YEAR, MONTH, DAY, TIME].map(function(regexString) {
      return "(" + regexString + ")?";
    }).join("\\s*"));
    var positions = {
      years: 2,
      months: 4,
      days: 6,
      hours: 9,
      minutes: 10,
      seconds: 11,
      milliseconds: 12
    };
    var negatives = ["hours", "minutes", "seconds", "milliseconds"];
    function parseMilliseconds(fraction) {
      var microseconds = fraction + "000000".slice(fraction.length);
      return parseInt(microseconds, 10) / 1e3;
    }
    function parse(interval) {
      if (!interval) return {};
      var matches = INTERVAL.exec(interval);
      var isNegative = matches[8] === "-";
      return Object.keys(positions).reduce(function(parsed, property) {
        var position = positions[property];
        var value = matches[position];
        if (!value) return parsed;
        value = property === "milliseconds" ? parseMilliseconds(value) : parseInt(value, 10);
        if (!value) return parsed;
        if (isNegative && ~negatives.indexOf(property)) {
          value *= -1;
        }
        parsed[property] = value;
        return parsed;
      }, {});
    }
  }
});

// scheduler/node_modules/postgres-bytea/index.js
var require_postgres_bytea = __commonJS({
  "scheduler/node_modules/postgres-bytea/index.js"(exports, module) {
    "use strict";
    var bufferFrom = Buffer.from || Buffer;
    module.exports = function parseBytea(input) {
      if (/^\\x/.test(input)) {
        return bufferFrom(input.substr(2), "hex");
      }
      var output = "";
      var i = 0;
      while (i < input.length) {
        if (input[i] !== "\\") {
          output += input[i];
          ++i;
        } else {
          if (/[0-7]{3}/.test(input.substr(i + 1, 3))) {
            output += String.fromCharCode(parseInt(input.substr(i + 1, 3), 8));
            i += 4;
          } else {
            var backslashes = 1;
            while (i + backslashes < input.length && input[i + backslashes] === "\\") {
              backslashes++;
            }
            for (var k = 0; k < Math.floor(backslashes / 2); ++k) {
              output += "\\";
            }
            i += Math.floor(backslashes / 2) * 2;
          }
        }
      }
      return bufferFrom(output, "binary");
    };
  }
});

// scheduler/node_modules/pg-types/lib/textParsers.js
var require_textParsers = __commonJS({
  "scheduler/node_modules/pg-types/lib/textParsers.js"(exports, module) {
    var array = require_postgres_array();
    var arrayParser = require_arrayParser();
    var parseDate = require_postgres_date();
    var parseInterval = require_postgres_interval();
    var parseByteA = require_postgres_bytea();
    function allowNull(fn) {
      return function nullAllowed(value) {
        if (value === null) return value;
        return fn(value);
      };
    }
    function parseBool(value) {
      if (value === null) return value;
      return value === "TRUE" || value === "t" || value === "true" || value === "y" || value === "yes" || value === "on" || value === "1";
    }
    function parseBoolArray(value) {
      if (!value) return null;
      return array.parse(value, parseBool);
    }
    function parseBaseTenInt(string) {
      return parseInt(string, 10);
    }
    function parseIntegerArray(value) {
      if (!value) return null;
      return array.parse(value, allowNull(parseBaseTenInt));
    }
    function parseBigIntegerArray(value) {
      if (!value) return null;
      return array.parse(value, allowNull(function(entry) {
        return parseBigInteger(entry).trim();
      }));
    }
    var parsePointArray = function(value) {
      if (!value) {
        return null;
      }
      var p = arrayParser.create(value, function(entry) {
        if (entry !== null) {
          entry = parsePoint(entry);
        }
        return entry;
      });
      return p.parse();
    };
    var parseFloatArray = function(value) {
      if (!value) {
        return null;
      }
      var p = arrayParser.create(value, function(entry) {
        if (entry !== null) {
          entry = parseFloat(entry);
        }
        return entry;
      });
      return p.parse();
    };
    var parseStringArray = function(value) {
      if (!value) {
        return null;
      }
      var p = arrayParser.create(value);
      return p.parse();
    };
    var parseDateArray = function(value) {
      if (!value) {
        return null;
      }
      var p = arrayParser.create(value, function(entry) {
        if (entry !== null) {
          entry = parseDate(entry);
        }
        return entry;
      });
      return p.parse();
    };
    var parseIntervalArray = function(value) {
      if (!value) {
        return null;
      }
      var p = arrayParser.create(value, function(entry) {
        if (entry !== null) {
          entry = parseInterval(entry);
        }
        return entry;
      });
      return p.parse();
    };
    var parseByteAArray = function(value) {
      if (!value) {
        return null;
      }
      return array.parse(value, allowNull(parseByteA));
    };
    var parseInteger = function(value) {
      return parseInt(value, 10);
    };
    var parseBigInteger = function(value) {
      var valStr = String(value);
      if (/^\d+$/.test(valStr)) {
        return valStr;
      }
      return value;
    };
    var parseJsonArray = function(value) {
      if (!value) {
        return null;
      }
      return array.parse(value, allowNull(JSON.parse));
    };
    var parsePoint = function(value) {
      if (value[0] !== "(") {
        return null;
      }
      value = value.substring(1, value.length - 1).split(",");
      return {
        x: parseFloat(value[0]),
        y: parseFloat(value[1])
      };
    };
    var parseCircle = function(value) {
      if (value[0] !== "<" && value[1] !== "(") {
        return null;
      }
      var point = "(";
      var radius = "";
      var pointParsed = false;
      for (var i = 2; i < value.length - 1; i++) {
        if (!pointParsed) {
          point += value[i];
        }
        if (value[i] === ")") {
          pointParsed = true;
          continue;
        } else if (!pointParsed) {
          continue;
        }
        if (value[i] === ",") {
          continue;
        }
        radius += value[i];
      }
      var result = parsePoint(point);
      result.radius = parseFloat(radius);
      return result;
    };
    var init = function(register2) {
      register2(20, parseBigInteger);
      register2(21, parseInteger);
      register2(23, parseInteger);
      register2(26, parseInteger);
      register2(700, parseFloat);
      register2(701, parseFloat);
      register2(16, parseBool);
      register2(1082, parseDate);
      register2(1114, parseDate);
      register2(1184, parseDate);
      register2(600, parsePoint);
      register2(651, parseStringArray);
      register2(718, parseCircle);
      register2(1e3, parseBoolArray);
      register2(1001, parseByteAArray);
      register2(1005, parseIntegerArray);
      register2(1007, parseIntegerArray);
      register2(1028, parseIntegerArray);
      register2(1016, parseBigIntegerArray);
      register2(1017, parsePointArray);
      register2(1021, parseFloatArray);
      register2(1022, parseFloatArray);
      register2(1231, parseFloatArray);
      register2(1014, parseStringArray);
      register2(1015, parseStringArray);
      register2(1008, parseStringArray);
      register2(1009, parseStringArray);
      register2(1040, parseStringArray);
      register2(1041, parseStringArray);
      register2(1115, parseDateArray);
      register2(1182, parseDateArray);
      register2(1185, parseDateArray);
      register2(1186, parseInterval);
      register2(1187, parseIntervalArray);
      register2(17, parseByteA);
      register2(114, JSON.parse.bind(JSON));
      register2(3802, JSON.parse.bind(JSON));
      register2(199, parseJsonArray);
      register2(3807, parseJsonArray);
      register2(3907, parseStringArray);
      register2(2951, parseStringArray);
      register2(791, parseStringArray);
      register2(1183, parseStringArray);
      register2(1270, parseStringArray);
    };
    module.exports = {
      init
    };
  }
});

// scheduler/node_modules/pg-int8/index.js
var require_pg_int8 = __commonJS({
  "scheduler/node_modules/pg-int8/index.js"(exports, module) {
    "use strict";
    var BASE = 1e6;
    function readInt8(buffer) {
      var high = buffer.readInt32BE(0);
      var low = buffer.readUInt32BE(4);
      var sign2 = "";
      if (high < 0) {
        high = ~high + (low === 0);
        low = ~low + 1 >>> 0;
        sign2 = "-";
      }
      var result = "";
      var carry;
      var t;
      var digits;
      var pad;
      var l;
      var i;
      {
        carry = high % BASE;
        high = high / BASE >>> 0;
        t = 4294967296 * carry + low;
        low = t / BASE >>> 0;
        digits = "" + (t - BASE * low);
        if (low === 0 && high === 0) {
          return sign2 + digits + result;
        }
        pad = "";
        l = 6 - digits.length;
        for (i = 0; i < l; i++) {
          pad += "0";
        }
        result = pad + digits + result;
      }
      {
        carry = high % BASE;
        high = high / BASE >>> 0;
        t = 4294967296 * carry + low;
        low = t / BASE >>> 0;
        digits = "" + (t - BASE * low);
        if (low === 0 && high === 0) {
          return sign2 + digits + result;
        }
        pad = "";
        l = 6 - digits.length;
        for (i = 0; i < l; i++) {
          pad += "0";
        }
        result = pad + digits + result;
      }
      {
        carry = high % BASE;
        high = high / BASE >>> 0;
        t = 4294967296 * carry + low;
        low = t / BASE >>> 0;
        digits = "" + (t - BASE * low);
        if (low === 0 && high === 0) {
          return sign2 + digits + result;
        }
        pad = "";
        l = 6 - digits.length;
        for (i = 0; i < l; i++) {
          pad += "0";
        }
        result = pad + digits + result;
      }
      {
        carry = high % BASE;
        t = 4294967296 * carry + low;
        digits = "" + t % BASE;
        return sign2 + digits + result;
      }
    }
    module.exports = readInt8;
  }
});

// scheduler/node_modules/pg-types/lib/binaryParsers.js
var require_binaryParsers = __commonJS({
  "scheduler/node_modules/pg-types/lib/binaryParsers.js"(exports, module) {
    var parseInt64 = require_pg_int8();
    var parseBits = function(data, bits, offset, invert, callback) {
      offset = offset || 0;
      invert = invert || false;
      callback = callback || function(lastValue, newValue, bits2) {
        return lastValue * Math.pow(2, bits2) + newValue;
      };
      var offsetBytes = offset >> 3;
      var inv = function(value) {
        if (invert) {
          return ~value & 255;
        }
        return value;
      };
      var mask = 255;
      var firstBits = 8 - offset % 8;
      if (bits < firstBits) {
        mask = 255 << 8 - bits & 255;
        firstBits = bits;
      }
      if (offset) {
        mask = mask >> offset % 8;
      }
      var result = 0;
      if (offset % 8 + bits >= 8) {
        result = callback(0, inv(data[offsetBytes]) & mask, firstBits);
      }
      var bytes = bits + offset >> 3;
      for (var i = offsetBytes + 1; i < bytes; i++) {
        result = callback(result, inv(data[i]), 8);
      }
      var lastBits = (bits + offset) % 8;
      if (lastBits > 0) {
        result = callback(result, inv(data[bytes]) >> 8 - lastBits, lastBits);
      }
      return result;
    };
    var parseFloatFromBits = function(data, precisionBits, exponentBits) {
      var bias = Math.pow(2, exponentBits - 1) - 1;
      var sign2 = parseBits(data, 1);
      var exponent = parseBits(data, exponentBits, 1);
      if (exponent === 0) {
        return 0;
      }
      var precisionBitsCounter = 1;
      var parsePrecisionBits = function(lastValue, newValue, bits) {
        if (lastValue === 0) {
          lastValue = 1;
        }
        for (var i = 1; i <= bits; i++) {
          precisionBitsCounter /= 2;
          if ((newValue & 1 << bits - i) > 0) {
            lastValue += precisionBitsCounter;
          }
        }
        return lastValue;
      };
      var mantissa = parseBits(data, precisionBits, exponentBits + 1, false, parsePrecisionBits);
      if (exponent == Math.pow(2, exponentBits + 1) - 1) {
        if (mantissa === 0) {
          return sign2 === 0 ? Infinity : -Infinity;
        }
        return NaN;
      }
      return (sign2 === 0 ? 1 : -1) * Math.pow(2, exponent - bias) * mantissa;
    };
    var parseInt16 = function(value) {
      if (parseBits(value, 1) == 1) {
        return -1 * (parseBits(value, 15, 1, true) + 1);
      }
      return parseBits(value, 15, 1);
    };
    var parseInt32 = function(value) {
      if (parseBits(value, 1) == 1) {
        return -1 * (parseBits(value, 31, 1, true) + 1);
      }
      return parseBits(value, 31, 1);
    };
    var parseFloat32 = function(value) {
      return parseFloatFromBits(value, 23, 8);
    };
    var parseFloat64 = function(value) {
      return parseFloatFromBits(value, 52, 11);
    };
    var parseNumeric = function(value) {
      var sign2 = parseBits(value, 16, 32);
      if (sign2 == 49152) {
        return NaN;
      }
      var weight = Math.pow(1e4, parseBits(value, 16, 16));
      var result = 0;
      var digits = [];
      var ndigits = parseBits(value, 16);
      for (var i = 0; i < ndigits; i++) {
        result += parseBits(value, 16, 64 + 16 * i) * weight;
        weight /= 1e4;
      }
      var scale = Math.pow(10, parseBits(value, 16, 48));
      return (sign2 === 0 ? 1 : -1) * Math.round(result * scale) / scale;
    };
    var parseDate = function(isUTC, value) {
      var sign2 = parseBits(value, 1);
      var rawValue = parseBits(value, 63, 1);
      var result = new Date((sign2 === 0 ? 1 : -1) * rawValue / 1e3 + 9466848e5);
      if (!isUTC) {
        result.setTime(result.getTime() + result.getTimezoneOffset() * 6e4);
      }
      result.usec = rawValue % 1e3;
      result.getMicroSeconds = function() {
        return this.usec;
      };
      result.setMicroSeconds = function(value2) {
        this.usec = value2;
      };
      result.getUTCMicroSeconds = function() {
        return this.usec;
      };
      return result;
    };
    var parseArray = function(value) {
      var dim = parseBits(value, 32);
      var flags = parseBits(value, 32, 32);
      var elementType = parseBits(value, 32, 64);
      var offset = 96;
      var dims = [];
      for (var i = 0; i < dim; i++) {
        dims[i] = parseBits(value, 32, offset);
        offset += 32;
        offset += 32;
      }
      var parseElement = function(elementType2) {
        var length = parseBits(value, 32, offset);
        offset += 32;
        if (length == 4294967295) {
          return null;
        }
        var result;
        if (elementType2 == 23 || elementType2 == 20) {
          result = parseBits(value, length * 8, offset);
          offset += length * 8;
          return result;
        } else if (elementType2 == 25) {
          result = value.toString(this.encoding, offset >> 3, (offset += length << 3) >> 3);
          return result;
        } else {
          console.log("ERROR: ElementType not implemented: " + elementType2);
        }
      };
      var parse = function(dimension, elementType2) {
        var array = [];
        var i2;
        if (dimension.length > 1) {
          var count2 = dimension.shift();
          for (i2 = 0; i2 < count2; i2++) {
            array[i2] = parse(dimension, elementType2);
          }
          dimension.unshift(count2);
        } else {
          for (i2 = 0; i2 < dimension[0]; i2++) {
            array[i2] = parseElement(elementType2);
          }
        }
        return array;
      };
      return parse(dims, elementType);
    };
    var parseText = function(value) {
      return value.toString("utf8");
    };
    var parseBool = function(value) {
      if (value === null) return null;
      return parseBits(value, 8) > 0;
    };
    var init = function(register2) {
      register2(20, parseInt64);
      register2(21, parseInt16);
      register2(23, parseInt32);
      register2(26, parseInt32);
      register2(1700, parseNumeric);
      register2(700, parseFloat32);
      register2(701, parseFloat64);
      register2(16, parseBool);
      register2(1114, parseDate.bind(null, false));
      register2(1184, parseDate.bind(null, true));
      register2(1e3, parseArray);
      register2(1007, parseArray);
      register2(1016, parseArray);
      register2(1008, parseArray);
      register2(1009, parseArray);
      register2(25, parseText);
    };
    module.exports = {
      init
    };
  }
});

// scheduler/node_modules/pg-types/lib/builtins.js
var require_builtins = __commonJS({
  "scheduler/node_modules/pg-types/lib/builtins.js"(exports, module) {
    module.exports = {
      BOOL: 16,
      BYTEA: 17,
      CHAR: 18,
      INT8: 20,
      INT2: 21,
      INT4: 23,
      REGPROC: 24,
      TEXT: 25,
      OID: 26,
      TID: 27,
      XID: 28,
      CID: 29,
      JSON: 114,
      XML: 142,
      PG_NODE_TREE: 194,
      SMGR: 210,
      PATH: 602,
      POLYGON: 604,
      CIDR: 650,
      FLOAT4: 700,
      FLOAT8: 701,
      ABSTIME: 702,
      RELTIME: 703,
      TINTERVAL: 704,
      CIRCLE: 718,
      MACADDR8: 774,
      MONEY: 790,
      MACADDR: 829,
      INET: 869,
      ACLITEM: 1033,
      BPCHAR: 1042,
      VARCHAR: 1043,
      DATE: 1082,
      TIME: 1083,
      TIMESTAMP: 1114,
      TIMESTAMPTZ: 1184,
      INTERVAL: 1186,
      TIMETZ: 1266,
      BIT: 1560,
      VARBIT: 1562,
      NUMERIC: 1700,
      REFCURSOR: 1790,
      REGPROCEDURE: 2202,
      REGOPER: 2203,
      REGOPERATOR: 2204,
      REGCLASS: 2205,
      REGTYPE: 2206,
      UUID: 2950,
      TXID_SNAPSHOT: 2970,
      PG_LSN: 3220,
      PG_NDISTINCT: 3361,
      PG_DEPENDENCIES: 3402,
      TSVECTOR: 3614,
      TSQUERY: 3615,
      GTSVECTOR: 3642,
      REGCONFIG: 3734,
      REGDICTIONARY: 3769,
      JSONB: 3802,
      REGNAMESPACE: 4089,
      REGROLE: 4096
    };
  }
});

// scheduler/node_modules/pg-types/index.js
var require_pg_types = __commonJS({
  "scheduler/node_modules/pg-types/index.js"(exports) {
    var textParsers = require_textParsers();
    var binaryParsers = require_binaryParsers();
    var arrayParser = require_arrayParser();
    var builtinTypes = require_builtins();
    exports.getTypeParser = getTypeParser;
    exports.setTypeParser = setTypeParser;
    exports.arrayParser = arrayParser;
    exports.builtins = builtinTypes;
    var typeParsers = {
      text: {},
      binary: {}
    };
    function noParse(val) {
      return String(val);
    }
    function getTypeParser(oid, format) {
      format = format || "text";
      if (!typeParsers[format]) {
        return noParse;
      }
      return typeParsers[format][oid] || noParse;
    }
    function setTypeParser(oid, format, parseFn) {
      if (typeof format == "function") {
        parseFn = format;
        format = "text";
      }
      typeParsers[format][oid] = parseFn;
    }
    textParsers.init(function(oid, converter) {
      typeParsers.text[oid] = converter;
    });
    binaryParsers.init(function(oid, converter) {
      typeParsers.binary[oid] = converter;
    });
  }
});

// scheduler/node_modules/pg/lib/defaults.js
var require_defaults = __commonJS({
  "scheduler/node_modules/pg/lib/defaults.js"(exports, module) {
    "use strict";
    var user;
    try {
      user = process.platform === "win32" ? process.env.USERNAME : process.env.USER;
    } catch {
    }
    module.exports = {
      // database host. defaults to localhost
      host: "localhost",
      // database user's name
      user,
      // name of database to connect
      database: void 0,
      // database user's password
      password: null,
      // a Postgres connection string to be used instead of setting individual connection items
      // NOTE:  Setting this value will cause it to override any other value (such as database or user) defined
      // in the defaults object.
      connectionString: void 0,
      // database port
      port: 5432,
      // number of rows to return at a time from a prepared statement's
      // portal. 0 will return all rows at once
      rows: 0,
      // binary result mode
      binary: false,
      // Connection pool options - see https://github.com/brianc/node-pg-pool
      // number of connections to use in connection pool
      // 0 will disable connection pooling
      max: 10,
      // max milliseconds a client can go unused before it is removed
      // from the pool and destroyed
      idleTimeoutMillis: 3e4,
      client_encoding: "",
      ssl: false,
      // SSL negotiation style: 'postgres' (traditional SSLRequest) or 'direct'
      sslnegotiation: void 0,
      application_name: void 0,
      fallback_application_name: void 0,
      options: void 0,
      parseInputDatesAsUTC: false,
      // max milliseconds any query using this connection will execute for before timing out in error.
      // false=unlimited
      statement_timeout: false,
      // Abort any statement that waits longer than the specified duration in milliseconds while attempting to acquire a lock.
      // false=unlimited
      lock_timeout: false,
      // Terminate any session with an open transaction that has been idle for longer than the specified duration in milliseconds
      // false=unlimited
      idle_in_transaction_session_timeout: false,
      // max milliseconds to wait for query to complete (client side)
      query_timeout: false,
      connect_timeout: 0,
      keepalives: 1,
      keepalives_idle: 0
    };
    var pgTypes = require_pg_types();
    var parseBigInteger = pgTypes.getTypeParser(20, "text");
    var parseBigIntegerArray = pgTypes.getTypeParser(1016, "text");
    module.exports.__defineSetter__("parseInt8", function(val) {
      pgTypes.setTypeParser(20, "text", val ? pgTypes.getTypeParser(23, "text") : parseBigInteger);
      pgTypes.setTypeParser(1016, "text", val ? pgTypes.getTypeParser(1007, "text") : parseBigIntegerArray);
    });
  }
});

// scheduler/node_modules/pg/lib/utils.js
var require_utils = __commonJS({
  "scheduler/node_modules/pg/lib/utils.js"(exports, module) {
    "use strict";
    var defaults2 = require_defaults();
    var nodeUtils = __require("util");
    var { isDate } = __require("util/types");
    var invalidDateDeprecationNotice = nodeUtils.deprecate(
      () => {
      },
      "Sending an invalid date to Postgres is deprecated and will throw an error in the next major version of pg. Ensure any Date object passed as a query parameter is valid.",
      "PG_INVALID_DATE"
    );
    function escapeElement(elementRepresentation) {
      const escaped = elementRepresentation.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      return '"' + escaped + '"';
    }
    function arrayString(val) {
      let result = "{";
      for (let i = 0; i < val.length; i++) {
        if (i > 0) {
          result += ",";
        }
        let item = val[i];
        if (item == null) {
          result += "NULL";
        } else if (Array.isArray(item)) {
          result += arrayString(item);
        } else if (ArrayBuffer.isView(item)) {
          if (!(item instanceof Buffer)) {
            item = Buffer.from(item.buffer, item.byteOffset, item.byteLength);
          }
          result += "\\\\x" + item.toString("hex");
        } else {
          result += escapeElement(prepareValue(item));
        }
      }
      result += "}";
      return result;
    }
    var prepareValue = function(val, seen) {
      if (val == null) {
        return null;
      }
      if (typeof val === "object") {
        if (val instanceof Buffer) {
          return val;
        }
        if (ArrayBuffer.isView(val)) {
          return Buffer.from(val.buffer, val.byteOffset, val.byteLength);
        }
        if (isDate(val)) {
          if (isNaN(val.getTime())) {
            invalidDateDeprecationNotice();
          }
          if (defaults2.parseInputDatesAsUTC) {
            return dateToStringUTC(val);
          } else {
            return dateToString(val);
          }
        }
        if (Array.isArray(val)) {
          return arrayString(val);
        }
        return prepareObject(val, seen);
      }
      return val.toString();
    };
    function prepareObject(val, seen) {
      if (val && typeof val.toPostgres === "function") {
        seen = seen || [];
        if (seen.indexOf(val) !== -1) {
          throw new Error('circular reference detected while preparing "' + val + '" for query');
        }
        seen.push(val);
        return prepareValue(val.toPostgres(prepareValue), seen);
      }
      return JSON.stringify(val);
    }
    function dateToString(date) {
      let offset = -date.getTimezoneOffset();
      let year = date.getFullYear();
      const isBCYear = year < 1;
      if (isBCYear) year = Math.abs(year) + 1;
      let ret = String(year).padStart(4, "0") + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0") + "T" + String(date.getHours()).padStart(2, "0") + ":" + String(date.getMinutes()).padStart(2, "0") + ":" + String(date.getSeconds()).padStart(2, "0") + "." + String(date.getMilliseconds()).padStart(3, "0");
      if (offset < 0) {
        ret += "-";
        offset *= -1;
      } else {
        ret += "+";
      }
      ret += String(Math.floor(offset / 60)).padStart(2, "0") + ":" + String(offset % 60).padStart(2, "0");
      if (isBCYear) ret += " BC";
      return ret;
    }
    function dateToStringUTC(date) {
      let year = date.getUTCFullYear();
      const isBCYear = year < 1;
      if (isBCYear) year = Math.abs(year) + 1;
      let ret = String(year).padStart(4, "0") + "-" + String(date.getUTCMonth() + 1).padStart(2, "0") + "-" + String(date.getUTCDate()).padStart(2, "0") + "T" + String(date.getUTCHours()).padStart(2, "0") + ":" + String(date.getUTCMinutes()).padStart(2, "0") + ":" + String(date.getUTCSeconds()).padStart(2, "0") + "." + String(date.getUTCMilliseconds()).padStart(3, "0");
      ret += "+00:00";
      if (isBCYear) ret += " BC";
      return ret;
    }
    function normalizeQueryConfig(config2, values, callback) {
      config2 = typeof config2 === "string" ? { text: config2 } : cloneQueryConfig(config2);
      if (values) {
        if (typeof values === "function") {
          config2.callback = values;
        } else {
          config2.values = values;
        }
      }
      if (callback) {
        config2.callback = callback;
      }
      return config2;
    }
    function cloneQueryConfig(config2) {
      if (config2 == null) {
        return config2;
      }
      return Object.defineProperties(Object.create(Object.getPrototypeOf(config2)), Object.getOwnPropertyDescriptors(config2));
    }
    var escapeIdentifier2 = function(str) {
      return '"' + str.replace(/"/g, '""') + '"';
    };
    var escapeLiteral2 = function(str) {
      let hasBackslash = false;
      let escaped = "'";
      if (str == null) {
        return "''";
      }
      if (typeof str !== "string") {
        return "''";
      }
      for (let i = 0; i < str.length; i++) {
        const c = str[i];
        if (c === "'") {
          escaped += c + c;
        } else if (c === "\\") {
          escaped += c + c;
          hasBackslash = true;
        } else {
          escaped += c;
        }
      }
      escaped += "'";
      if (hasBackslash === true) {
        escaped = " E" + escaped;
      }
      return escaped;
    };
    module.exports = {
      prepareValue: function prepareValueWrapper(value) {
        return prepareValue(value);
      },
      normalizeQueryConfig,
      escapeIdentifier: escapeIdentifier2,
      escapeLiteral: escapeLiteral2
    };
  }
});

// scheduler/node_modules/pg/lib/crypto/utils.js
var require_utils2 = __commonJS({
  "scheduler/node_modules/pg/lib/crypto/utils.js"(exports, module) {
    var nodeCrypto = __require("crypto");
    module.exports = {
      postgresMd5PasswordHash,
      randomBytes: randomBytes2,
      deriveKey,
      sha256,
      hashByName,
      hmacSha256,
      md5
    };
    var webCrypto = nodeCrypto.webcrypto || globalThis.crypto;
    var subtleCrypto = webCrypto.subtle;
    var textEncoder = new TextEncoder();
    function randomBytes2(length) {
      return webCrypto.getRandomValues(Buffer.alloc(length));
    }
    async function md5(string) {
      try {
        return nodeCrypto.createHash("md5").update(string, "utf-8").digest("hex");
      } catch (e) {
        const data = typeof string === "string" ? textEncoder.encode(string) : string;
        const hash = await subtleCrypto.digest("MD5", data);
        return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
      }
    }
    async function postgresMd5PasswordHash(user, password, salt) {
      const inner = await md5(password + user);
      const outer = await md5(Buffer.concat([Buffer.from(inner), salt]));
      return "md5" + outer;
    }
    async function sha256(text) {
      return await subtleCrypto.digest("SHA-256", text);
    }
    async function hashByName(hashName, text) {
      return await subtleCrypto.digest(hashName, text);
    }
    async function hmacSha256(keyBuffer, msg) {
      const key = await subtleCrypto.importKey("raw", keyBuffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      return await subtleCrypto.sign("HMAC", key, textEncoder.encode(msg));
    }
    async function deriveKey(password, salt, iterations) {
      const key = await subtleCrypto.importKey("raw", textEncoder.encode(password), "PBKDF2", false, ["deriveBits"]);
      const params = { name: "PBKDF2", hash: "SHA-256", salt, iterations };
      return await subtleCrypto.deriveBits(params, key, 32 * 8, ["deriveBits"]);
    }
  }
});

// scheduler/node_modules/pg/lib/crypto/cert-signatures.js
var require_cert_signatures = __commonJS({
  "scheduler/node_modules/pg/lib/crypto/cert-signatures.js"(exports, module) {
    function x509Error(msg, cert) {
      return new Error("SASL channel binding: " + msg + " when parsing public certificate " + cert.toString("base64"));
    }
    function readASN1Length(data, index) {
      let length = data[index++];
      if (length < 128) return { length, index };
      const lengthBytes = length & 127;
      if (lengthBytes > 4) throw x509Error("bad length", data);
      length = 0;
      for (let i = 0; i < lengthBytes; i++) {
        length = length << 8 | data[index++];
      }
      return { length, index };
    }
    function readASN1OID(data, index) {
      if (data[index++] !== 6) throw x509Error("non-OID data", data);
      const { length: OIDLength, index: indexAfterOIDLength } = readASN1Length(data, index);
      index = indexAfterOIDLength;
      const lastIndex = index + OIDLength;
      const byte1 = data[index++];
      let oid = (byte1 / 40 >> 0) + "." + byte1 % 40;
      while (index < lastIndex) {
        let value = 0;
        while (index < lastIndex) {
          const nextByte = data[index++];
          value = value << 7 | nextByte & 127;
          if (nextByte < 128) break;
        }
        oid += "." + value;
      }
      return { oid, index };
    }
    function expectASN1Seq(data, index) {
      if (data[index++] !== 48) throw x509Error("non-sequence data", data);
      return readASN1Length(data, index);
    }
    function signatureAlgorithmHashFromCertificate(data, index) {
      if (index === void 0) index = 0;
      index = expectASN1Seq(data, index).index;
      const { length: certInfoLength, index: indexAfterCertInfoLength } = expectASN1Seq(data, index);
      index = indexAfterCertInfoLength + certInfoLength;
      index = expectASN1Seq(data, index).index;
      const { oid, index: indexAfterOID } = readASN1OID(data, index);
      switch (oid) {
        // RSA
        case "1.2.840.113549.1.1.4":
          return "MD5";
        case "1.2.840.113549.1.1.5":
          return "SHA-1";
        case "1.2.840.113549.1.1.11":
          return "SHA-256";
        case "1.2.840.113549.1.1.12":
          return "SHA-384";
        case "1.2.840.113549.1.1.13":
          return "SHA-512";
        case "1.2.840.113549.1.1.14":
          return "SHA-224";
        case "1.2.840.113549.1.1.15":
          return "SHA512-224";
        case "1.2.840.113549.1.1.16":
          return "SHA512-256";
        // ECDSA
        case "1.2.840.10045.4.1":
          return "SHA-1";
        case "1.2.840.10045.4.3.1":
          return "SHA-224";
        case "1.2.840.10045.4.3.2":
          return "SHA-256";
        case "1.2.840.10045.4.3.3":
          return "SHA-384";
        case "1.2.840.10045.4.3.4":
          return "SHA-512";
        // RSASSA-PSS: hash is indicated separately
        case "1.2.840.113549.1.1.10": {
          index = indexAfterOID;
          index = expectASN1Seq(data, index).index;
          if (data[index++] !== 160) throw x509Error("non-tag data", data);
          index = readASN1Length(data, index).index;
          index = expectASN1Seq(data, index).index;
          const { oid: hashOID } = readASN1OID(data, index);
          switch (hashOID) {
            // standalone hash OIDs
            case "1.2.840.113549.2.5":
              return "MD5";
            case "1.3.14.3.2.26":
              return "SHA-1";
            case "2.16.840.1.101.3.4.2.1":
              return "SHA-256";
            case "2.16.840.1.101.3.4.2.2":
              return "SHA-384";
            case "2.16.840.1.101.3.4.2.3":
              return "SHA-512";
          }
          throw x509Error("unknown hash OID " + hashOID, data);
        }
        // Ed25519 -- see https://github.com/openssl/openssl/issues/15477
        case "1.3.101.110":
        case "1.3.101.112":
          return "SHA-512";
        // Ed448 -- still not in pg 17.2 (if supported, digest would be SHAKE256 x 64 bytes)
        case "1.3.101.111":
        case "1.3.101.113":
          throw x509Error("Ed448 certificate channel binding is not currently supported by Postgres");
      }
      throw x509Error("unknown OID " + oid, data);
    }
    module.exports = { signatureAlgorithmHashFromCertificate };
  }
});

// scheduler/node_modules/pg/lib/crypto/sasl.js
var require_sasl = __commonJS({
  "scheduler/node_modules/pg/lib/crypto/sasl.js"(exports, module) {
    "use strict";
    var crypto = require_utils2();
    var { signatureAlgorithmHashFromCertificate } = require_cert_signatures();
    function saslprep(password) {
      const nonAsciiSpace = /[\u00A0\u1680\u2000-\u200B\u202F\u205F\u3000]/g;
      const mappedToNothing = /[\u00AD\u034F\u1806\u180B\u180C\u180D\u200C\u200D\u2060\uFE00-\uFE0F\uFEFF]/g;
      return password.replace(nonAsciiSpace, " ").replace(mappedToNothing, "").normalize("NFKC");
    }
    var DEFAULT_MAX_SCRAM_ITERATIONS = 1e5;
    function startSession(mechanisms, stream, scramMaxIterations = DEFAULT_MAX_SCRAM_ITERATIONS) {
      const candidates = ["SCRAM-SHA-256"];
      if (stream) candidates.unshift("SCRAM-SHA-256-PLUS");
      const mechanism = candidates.find((candidate) => mechanisms.includes(candidate));
      if (!mechanism) {
        throw new Error("SASL: Only mechanism(s) " + candidates.join(" and ") + " are supported");
      }
      if (mechanism === "SCRAM-SHA-256-PLUS" && typeof stream.getPeerCertificate !== "function") {
        throw new Error("SASL: Mechanism SCRAM-SHA-256-PLUS requires a certificate");
      }
      const clientNonce = crypto.randomBytes(18).toString("base64");
      const gs2Header = mechanism === "SCRAM-SHA-256-PLUS" ? "p=tls-server-end-point" : stream ? "y" : "n";
      return {
        mechanism,
        clientNonce,
        response: gs2Header + ",,n=*,r=" + clientNonce,
        message: "SASLInitialResponse",
        scramMaxIterations
      };
    }
    async function continueSession(session, password, serverData, stream) {
      if (session.message !== "SASLInitialResponse") {
        throw new Error("SASL: Last message was not SASLInitialResponse");
      }
      if (typeof password !== "string") {
        throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string");
      }
      if (password === "") {
        throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a non-empty string");
      }
      if (typeof serverData !== "string") {
        throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: serverData must be a string");
      }
      const sv = parseServerFirstMessage(serverData);
      if (!sv.nonce.startsWith(session.clientNonce)) {
        throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: server nonce does not start with client nonce");
      } else if (sv.nonce.length === session.clientNonce.length) {
        throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: server nonce is too short");
      }
      const scramMaxIterations = typeof session.scramMaxIterations === "number" ? session.scramMaxIterations : DEFAULT_MAX_SCRAM_ITERATIONS;
      if (scramMaxIterations !== 0 && sv.iteration > scramMaxIterations) {
        throw new Error(
          "SASL: SCRAM-SERVER-FIRST-MESSAGE: iteration count " + sv.iteration + " exceeds scramMaxIterations of " + scramMaxIterations
        );
      }
      const clientFirstMessageBare = "n=*,r=" + session.clientNonce;
      const serverFirstMessage = "r=" + sv.nonce + ",s=" + sv.salt + ",i=" + sv.iteration;
      let channelBinding = stream ? "eSws" : "biws";
      if (session.mechanism === "SCRAM-SHA-256-PLUS") {
        const peerCert = stream.getPeerCertificate().raw;
        let hashName = signatureAlgorithmHashFromCertificate(peerCert);
        if (hashName === "MD5" || hashName === "SHA-1") hashName = "SHA-256";
        const certHash = await crypto.hashByName(hashName, peerCert);
        const bindingData = Buffer.concat([Buffer.from("p=tls-server-end-point,,"), Buffer.from(certHash)]);
        channelBinding = bindingData.toString("base64");
      }
      const clientFinalMessageWithoutProof = "c=" + channelBinding + ",r=" + sv.nonce;
      const authMessage = clientFirstMessageBare + "," + serverFirstMessage + "," + clientFinalMessageWithoutProof;
      const saltBytes = Buffer.from(sv.salt, "base64");
      const saltedPassword = await crypto.deriveKey(saslprep(password), saltBytes, sv.iteration);
      const clientKey = await crypto.hmacSha256(saltedPassword, "Client Key");
      const storedKey = await crypto.sha256(clientKey);
      const clientSignature = await crypto.hmacSha256(storedKey, authMessage);
      const clientProof = xorBuffers(Buffer.from(clientKey), Buffer.from(clientSignature)).toString("base64");
      const serverKey = await crypto.hmacSha256(saltedPassword, "Server Key");
      const serverSignatureBytes = await crypto.hmacSha256(serverKey, authMessage);
      session.message = "SASLResponse";
      session.serverSignature = Buffer.from(serverSignatureBytes).toString("base64");
      session.response = clientFinalMessageWithoutProof + ",p=" + clientProof;
    }
    function finalizeSession(session, serverData) {
      if (session.message !== "SASLResponse") {
        throw new Error("SASL: Last message was not SASLResponse");
      }
      if (typeof serverData !== "string") {
        throw new Error("SASL: SCRAM-SERVER-FINAL-MESSAGE: serverData must be a string");
      }
      const { serverSignature } = parseServerFinalMessage(serverData);
      if (serverSignature !== session.serverSignature) {
        throw new Error("SASL: SCRAM-SERVER-FINAL-MESSAGE: server signature does not match");
      }
    }
    function isPrintableChars(text) {
      if (typeof text !== "string") {
        throw new TypeError("SASL: text must be a string");
      }
      return text.split("").map((_, i) => text.charCodeAt(i)).every((c) => c >= 33 && c <= 43 || c >= 45 && c <= 126);
    }
    function isBase64(text) {
      return /^(?:[a-zA-Z0-9+/]{4})*(?:[a-zA-Z0-9+/]{2}==|[a-zA-Z0-9+/]{3}=)?$/.test(text);
    }
    function parseAttributePairs(text) {
      if (typeof text !== "string") {
        throw new TypeError("SASL: attribute pairs text must be a string");
      }
      return new Map(
        text.split(",").map((attrValue) => {
          if (!/^.=/.test(attrValue)) {
            throw new Error("SASL: Invalid attribute pair entry");
          }
          const name = attrValue[0];
          const value = attrValue.substring(2);
          return [name, value];
        })
      );
    }
    function parseServerFirstMessage(data) {
      const attrPairs = parseAttributePairs(data);
      const nonce = attrPairs.get("r");
      if (!nonce) {
        throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: nonce missing");
      } else if (!isPrintableChars(nonce)) {
        throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: nonce must only contain printable characters");
      }
      const salt = attrPairs.get("s");
      if (!salt) {
        throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: salt missing");
      } else if (!isBase64(salt)) {
        throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: salt must be base64");
      }
      const iterationText = attrPairs.get("i");
      if (!iterationText) {
        throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: iteration missing");
      } else if (!/^[1-9][0-9]*$/.test(iterationText)) {
        throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: invalid iteration count");
      }
      const iteration = parseInt(iterationText, 10);
      return {
        nonce,
        salt,
        iteration
      };
    }
    function parseServerFinalMessage(serverData) {
      const attrPairs = parseAttributePairs(serverData);
      const error = attrPairs.get("e");
      const serverSignature = attrPairs.get("v");
      if (error) {
        throw new Error(`SASL: SCRAM-SERVER-FINAL-MESSAGE: server returned error: "${error}"`);
      }
      if (!serverSignature) {
        throw new Error("SASL: SCRAM-SERVER-FINAL-MESSAGE: server signature is missing");
      } else if (!isBase64(serverSignature)) {
        throw new Error("SASL: SCRAM-SERVER-FINAL-MESSAGE: server signature must be base64");
      }
      return {
        serverSignature
      };
    }
    function xorBuffers(a, b) {
      if (!Buffer.isBuffer(a)) {
        throw new TypeError("first argument must be a Buffer");
      }
      if (!Buffer.isBuffer(b)) {
        throw new TypeError("second argument must be a Buffer");
      }
      if (a.length !== b.length) {
        throw new Error("Buffer lengths must match");
      }
      if (a.length === 0) {
        throw new Error("Buffers cannot be empty");
      }
      return Buffer.from(a.map((_, i) => a[i] ^ b[i]));
    }
    module.exports = {
      startSession,
      continueSession,
      finalizeSession,
      DEFAULT_MAX_SCRAM_ITERATIONS
    };
  }
});

// scheduler/node_modules/pg/lib/type-overrides.js
var require_type_overrides = __commonJS({
  "scheduler/node_modules/pg/lib/type-overrides.js"(exports, module) {
    "use strict";
    var types2 = require_pg_types();
    function TypeOverrides2(userTypes) {
      this._types = userTypes || types2;
      this.text = {};
      this.binary = {};
    }
    TypeOverrides2.prototype.getOverrides = function(format) {
      switch (format) {
        case "text":
          return this.text;
        case "binary":
          return this.binary;
        default:
          return {};
      }
    };
    TypeOverrides2.prototype.setTypeParser = function(oid, format, parseFn) {
      if (typeof format === "function") {
        parseFn = format;
        format = "text";
      }
      this.getOverrides(format)[oid] = parseFn;
    };
    TypeOverrides2.prototype.getTypeParser = function(oid, format) {
      format = format || "text";
      return this.getOverrides(format)[oid] || this._types.getTypeParser(oid, format);
    };
    module.exports = TypeOverrides2;
  }
});

// scheduler/node_modules/pg-connection-string/index.js
var require_pg_connection_string = __commonJS({
  "scheduler/node_modules/pg-connection-string/index.js"(exports, module) {
    "use strict";
    function parse(str, options = {}) {
      if (str.charAt(0) === "/") {
        const config3 = str.split(" ");
        return { host: config3[0], database: config3[1] };
      }
      const config2 = /* @__PURE__ */ Object.create(null);
      let result;
      let dummyHost = false;
      if (/ |%[^a-f0-9]|%[a-f0-9][^a-f0-9]/i.test(str)) {
        str = encodeURI(str).replace(/%25(\d\d)/g, "%$1");
      }
      try {
        try {
          result = new URL(str, "postgres://base");
        } catch (e) {
          result = new URL(str.replace("@/", "@___DUMMY___/"), "postgres://base");
          dummyHost = true;
        }
      } catch (err) {
        err.input && (err.input = "*****REDACTED*****");
        throw err;
      }
      for (const entry of result.searchParams.entries()) {
        config2[entry[0]] = entry[1];
      }
      config2.user = config2.user || decodeURIComponent(result.username);
      config2.password = config2.password || decodeURIComponent(result.password);
      if (result.protocol == "socket:") {
        config2.host = decodeURI(result.pathname);
        config2.database = result.searchParams.get("db");
        config2.client_encoding = result.searchParams.get("encoding");
        return config2;
      }
      const hostname = (dummyHost ? "" : result.hostname).replace(/^\[(.+)\]$/, "$1");
      if (!config2.host) {
        config2.host = decodeURIComponent(hostname);
      } else if (hostname && /^%2f/i.test(hostname)) {
        result.pathname = hostname + result.pathname;
      }
      if (!config2.port) {
        config2.port = result.port;
      }
      const pathname = result.pathname.slice(1) || null;
      config2.database = pathname ? decodeURI(pathname) : null;
      if (config2.ssl === "true" || config2.ssl === "1") {
        config2.ssl = true;
      }
      if (config2.ssl === "0") {
        config2.ssl = false;
      }
      if (config2.sslcert || config2.sslkey || config2.sslrootcert || config2.sslmode) {
        config2.ssl = {};
      }
      if (config2.sslnegotiation === "direct" && config2.ssl === void 0) {
        config2.ssl = true;
      }
      const fs4 = config2.sslcert || config2.sslkey || config2.sslrootcert ? __require("fs") : null;
      if (config2.sslcert) {
        config2.ssl.cert = fs4.readFileSync(config2.sslcert).toString();
      }
      if (config2.sslkey) {
        config2.ssl.key = fs4.readFileSync(config2.sslkey).toString();
      }
      if (config2.sslrootcert) {
        config2.ssl.ca = fs4.readFileSync(config2.sslrootcert).toString();
      }
      if (options.useLibpqCompat && config2.uselibpqcompat) {
        throw new Error("Both useLibpqCompat and uselibpqcompat are set. Please use only one of them.");
      }
      if (config2.uselibpqcompat === "true" || options.useLibpqCompat) {
        switch (config2.sslmode) {
          case "disable": {
            config2.ssl = false;
            break;
          }
          case "prefer": {
            config2.ssl.rejectUnauthorized = false;
            break;
          }
          case "require": {
            if (config2.sslrootcert) {
              config2.ssl.checkServerIdentity = function() {
              };
            } else {
              config2.ssl.rejectUnauthorized = false;
            }
            break;
          }
          case "verify-ca": {
            if (!config2.ssl.ca) {
              throw new Error(
                "SECURITY WARNING: Using sslmode=verify-ca requires specifying a CA with sslrootcert. If a public CA is used, verify-ca allows connections to a server that somebody else may have registered with the CA, making you vulnerable to Man-in-the-Middle attacks. Either specify a custom CA certificate with sslrootcert parameter or use sslmode=verify-full for proper security."
              );
            }
            config2.ssl.checkServerIdentity = function() {
            };
            break;
          }
          case "verify-full": {
            break;
          }
        }
      } else {
        switch (config2.sslmode) {
          case "disable": {
            config2.ssl = false;
            break;
          }
          case "prefer":
          case "require":
          case "verify-ca":
          case "verify-full": {
            if (config2.sslmode !== "verify-full") {
              deprecatedSslModeWarning(config2.sslmode);
            }
            break;
          }
          case "no-verify": {
            config2.ssl.rejectUnauthorized = false;
            break;
          }
        }
      }
      return config2;
    }
    function toConnectionOptions(sslConfig) {
      const connectionOptions = Object.entries(sslConfig).reduce((c, [key, value]) => {
        if (value !== void 0 && value !== null) {
          c[key] = value;
        }
        return c;
      }, /* @__PURE__ */ Object.create(null));
      return connectionOptions;
    }
    function toClientConfig(config2) {
      const poolConfig = Object.entries(config2).reduce((c, [key, value]) => {
        if (key === "ssl") {
          const sslConfig = value;
          if (typeof sslConfig === "boolean") {
            c[key] = sslConfig;
          }
          if (typeof sslConfig === "object") {
            c[key] = toConnectionOptions(sslConfig);
          }
        } else if (value !== void 0 && value !== null) {
          if (key === "port") {
            if (value !== "") {
              const v = parseInt(value, 10);
              if (isNaN(v)) {
                throw new Error(`Invalid ${key}: ${value}`);
              }
              c[key] = v;
            }
          } else {
            c[key] = value;
          }
        }
        return c;
      }, /* @__PURE__ */ Object.create(null));
      return poolConfig;
    }
    function parseIntoClientConfig(str) {
      return toClientConfig(parse(str));
    }
    function deprecatedSslModeWarning(sslmode) {
      if (!deprecatedSslModeWarning.warned && typeof process !== "undefined" && process.emitWarning) {
        deprecatedSslModeWarning.warned = true;
        process.emitWarning(`SECURITY WARNING: The SSL modes 'prefer', 'require', and 'verify-ca' are treated as aliases for 'verify-full'.
In the next major version (pg-connection-string v3.0.0 and pg v9.0.0), these modes will adopt standard libpq semantics, which have weaker security guarantees.

To prepare for this change:
- If you want the current behavior, explicitly use 'sslmode=verify-full'
- If you want libpq compatibility now, use 'uselibpqcompat=true&sslmode=${sslmode}'

See https://www.postgresql.org/docs/current/libpq-ssl.html for libpq SSL mode definitions.`);
      }
    }
    module.exports = parse;
    parse.parse = parse;
    parse.toClientConfig = toClientConfig;
    parse.parseIntoClientConfig = parseIntoClientConfig;
  }
});

// scheduler/node_modules/pg/lib/connection-parameters.js
var require_connection_parameters = __commonJS({
  "scheduler/node_modules/pg/lib/connection-parameters.js"(exports, module) {
    "use strict";
    var dns = __require("dns");
    var defaults2 = require_defaults();
    var parse = require_pg_connection_string().parse;
    var val = function(key, config2, envVar) {
      if (config2[key]) {
        return config2[key];
      }
      if (envVar === void 0) {
        envVar = process.env["PG" + key.toUpperCase()];
      } else if (envVar === false) {
      } else {
        envVar = process.env[envVar];
      }
      return envVar || defaults2[key];
    };
    var readSSLConfigFromEnvironment = function() {
      switch (process.env.PGSSLMODE) {
        case "disable":
          return false;
        case "prefer":
        case "require":
        case "verify-ca":
        case "verify-full":
          return true;
        case "no-verify":
          return { rejectUnauthorized: false };
      }
      return defaults2.ssl;
    };
    var quoteParamValue = function(value) {
      return "'" + ("" + value).replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
    };
    var add = function(params, config2, paramName) {
      const value = config2[paramName];
      if (value !== void 0 && value !== null) {
        params.push(paramName + "=" + quoteParamValue(value));
      }
    };
    var ConnectionParameters = class {
      constructor(config2) {
        config2 = typeof config2 === "string" ? parse(config2) : config2 || {};
        if (config2.connectionString) {
          config2 = Object.assign({}, config2, parse(config2.connectionString));
        }
        this.user = val("user", config2);
        this.database = val("database", config2);
        if (this.database === void 0) {
          this.database = this.user;
        }
        this.port = parseInt(val("port", config2), 10);
        this.host = val("host", config2);
        Object.defineProperty(this, "password", {
          configurable: true,
          enumerable: false,
          writable: true,
          value: val("password", config2)
        });
        this.binary = val("binary", config2);
        this.options = val("options", config2);
        this.ssl = typeof config2.ssl === "undefined" ? readSSLConfigFromEnvironment() : config2.ssl;
        if (typeof this.ssl === "string") {
          if (this.ssl === "true") {
            this.ssl = true;
          }
        }
        if (this.ssl === "no-verify") {
          this.ssl = { rejectUnauthorized: false };
        }
        if (this.ssl && this.ssl.key) {
          Object.defineProperty(this.ssl, "key", {
            enumerable: false
          });
        }
        this.sslnegotiation = val("sslnegotiation", config2, "PGSSLNEGOTIATION");
        if (this.sslnegotiation !== void 0 && this.sslnegotiation !== "postgres" && this.sslnegotiation !== "direct") {
          throw new Error(
            `Invalid sslnegotiation value: "${this.sslnegotiation}". Valid values are "postgres" and "direct".`
          );
        }
        if (this.sslnegotiation === "direct" && !this.ssl) {
          throw new Error("sslnegotiation=direct requires SSL to be enabled");
        }
        this.client_encoding = val("client_encoding", config2);
        this.replication = val("replication", config2);
        this.isDomainSocket = !(this.host || "").indexOf("/");
        this.application_name = val("application_name", config2, "PGAPPNAME");
        this.fallback_application_name = val("fallback_application_name", config2, false);
        this.statement_timeout = val("statement_timeout", config2, false);
        this.lock_timeout = val("lock_timeout", config2, false);
        this.idle_in_transaction_session_timeout = val("idle_in_transaction_session_timeout", config2, false);
        this.query_timeout = val("query_timeout", config2, false);
        if (config2.connectionTimeoutMillis === void 0) {
          this.connect_timeout = process.env.PGCONNECT_TIMEOUT || 0;
        } else {
          this.connect_timeout = Math.floor(config2.connectionTimeoutMillis / 1e3);
        }
        if (config2.keepAlive === false) {
          this.keepalives = 0;
        } else if (config2.keepAlive === true) {
          this.keepalives = 1;
        }
        if (typeof config2.keepAliveInitialDelayMillis === "number") {
          this.keepalives_idle = Math.floor(config2.keepAliveInitialDelayMillis / 1e3);
        }
      }
      getLibpqConnectionString(cb) {
        const params = [];
        add(params, this, "user");
        add(params, this, "password");
        add(params, this, "port");
        add(params, this, "application_name");
        add(params, this, "fallback_application_name");
        add(params, this, "connect_timeout");
        add(params, this, "options");
        const ssl = typeof this.ssl === "object" ? this.ssl : this.ssl ? { sslmode: this.ssl } : {};
        add(params, ssl, "sslmode");
        add(params, ssl, "sslca");
        add(params, ssl, "sslkey");
        add(params, ssl, "sslcert");
        add(params, ssl, "sslrootcert");
        add(params, this, "sslnegotiation");
        if (this.database) {
          params.push("dbname=" + quoteParamValue(this.database));
        }
        if (this.replication) {
          params.push("replication=" + quoteParamValue(this.replication));
        }
        if (this.host) {
          params.push("host=" + quoteParamValue(this.host));
        }
        if (this.isDomainSocket) {
          return cb(null, params.join(" "));
        }
        if (this.client_encoding) {
          params.push("client_encoding=" + quoteParamValue(this.client_encoding));
        }
        dns.lookup(this.host, function(err, address) {
          if (err) return cb(err, null);
          params.push("hostaddr=" + quoteParamValue(address));
          return cb(null, params.join(" "));
        });
      }
    };
    module.exports = ConnectionParameters;
  }
});

// scheduler/node_modules/pg/lib/result.js
var require_result = __commonJS({
  "scheduler/node_modules/pg/lib/result.js"(exports, module) {
    "use strict";
    var types2 = require_pg_types();
    var matchRegexp = /^([A-Za-z]+)(?: (\d+))?(?: (\d+))?/;
    var Result2 = class {
      constructor(rowMode, types3) {
        this.command = null;
        this.rowCount = null;
        this.oid = null;
        this.rows = [];
        this.fields = [];
        this._parsers = void 0;
        this._types = types3;
        this.RowCtor = null;
        this.rowAsArray = rowMode === "array";
        if (this.rowAsArray) {
          this.parseRow = this._parseRowAsArray;
        }
        this._prebuiltEmptyResultObject = null;
      }
      // adds a command complete message
      addCommandComplete(msg) {
        let match;
        if (msg.text) {
          match = matchRegexp.exec(msg.text);
        } else {
          match = matchRegexp.exec(msg.command);
        }
        if (match) {
          this.command = match[1];
          if (match[3]) {
            this.oid = parseInt(match[2], 10);
            this.rowCount = parseInt(match[3], 10);
          } else if (match[2]) {
            this.rowCount = parseInt(match[2], 10);
          }
        }
      }
      _parseRowAsArray(rowData) {
        const row = new Array(rowData.length);
        for (let i = 0, len = rowData.length; i < len; i++) {
          const rawValue = rowData[i];
          if (rawValue !== null) {
            row[i] = this._parsers[i](rawValue);
          } else {
            row[i] = null;
          }
        }
        return row;
      }
      parseRow(rowData) {
        const row = { ...this._prebuiltEmptyResultObject };
        for (let i = 0, len = rowData.length; i < len; i++) {
          const rawValue = rowData[i];
          const field = this.fields[i].name;
          if (rawValue !== null) {
            const v = this.fields[i].format === "binary" ? Buffer.from(rawValue) : rawValue;
            row[field] = this._parsers[i](v);
          } else {
            row[field] = null;
          }
        }
        return row;
      }
      addRow(row) {
        this.rows.push(row);
      }
      addFields(fieldDescriptions) {
        this.fields = fieldDescriptions;
        if (this.fields.length) {
          this._parsers = new Array(fieldDescriptions.length);
        }
        const row = /* @__PURE__ */ Object.create(null);
        for (let i = 0; i < fieldDescriptions.length; i++) {
          const desc = fieldDescriptions[i];
          row[desc.name] = null;
          if (this._types) {
            this._parsers[i] = this._types.getTypeParser(desc.dataTypeID, desc.format || "text");
          } else {
            this._parsers[i] = types2.getTypeParser(desc.dataTypeID, desc.format || "text");
          }
        }
        this._prebuiltEmptyResultObject = { ...row };
      }
    };
    module.exports = Result2;
  }
});

// scheduler/node_modules/pg/lib/query.js
var require_query = __commonJS({
  "scheduler/node_modules/pg/lib/query.js"(exports, module) {
    "use strict";
    var { EventEmitter } = __require("events");
    var Result2 = require_result();
    var utils = require_utils();
    var Query2 = class extends EventEmitter {
      constructor(config2, values, callback) {
        super();
        config2 = utils.normalizeQueryConfig(config2, values, callback);
        this.text = config2.text;
        this.values = config2.values;
        this.rows = config2.rows;
        this.types = config2.types;
        this.name = config2.name;
        this.queryMode = config2.queryMode;
        this.binary = config2.binary;
        this.portal = config2.portal || "";
        this.callback = config2.callback;
        this._rowMode = config2.rowMode;
        if (process.domain && config2.callback) {
          this.callback = process.domain.bind(config2.callback);
        }
        this._result = new Result2(this._rowMode, this.types);
        this._results = this._result;
        this._canceledDueToError = false;
      }
      requiresPreparation() {
        if (this.queryMode === "extended") {
          return true;
        }
        if (this.name) {
          return true;
        }
        if (this.rows) {
          return true;
        }
        if (!this.text) {
          return false;
        }
        if (!this.values) {
          return false;
        }
        return this.values.length > 0;
      }
      _checkForMultirow() {
        if (this._result.command) {
          if (!Array.isArray(this._results)) {
            this._results = [this._result];
          }
          this._result = new Result2(this._rowMode, this._result._types);
          this._results.push(this._result);
        }
      }
      // associates row metadata from the supplied
      // message with this query object
      // metadata used when parsing row results
      handleRowDescription(msg) {
        this._checkForMultirow();
        this._result.addFields(msg.fields);
        this._accumulateRows = this.callback || !this.listeners("row").length;
      }
      handleDataRow(msg) {
        let row;
        if (this._canceledDueToError) {
          return;
        }
        try {
          row = this._result.parseRow(msg.fields);
        } catch (err) {
          this._canceledDueToError = err;
          return;
        }
        this.emit("row", row, this._result);
        if (this._accumulateRows) {
          this._result.addRow(row);
        }
      }
      handleCommandComplete(msg, connection) {
        this._checkForMultirow();
        this._result.addCommandComplete(msg);
        if (this.rows) {
          connection.sync();
        }
      }
      // if a named prepared statement is created with empty query text
      // the backend will send an emptyQuery message but *not* a command complete message
      // since we pipeline sync immediately after execute we don't need to do anything here
      // unless we have rows specified, in which case we did not pipeline the initial sync call
      handleEmptyQuery(connection) {
        if (this.rows) {
          connection.sync();
        }
      }
      handleError(err, connection) {
        if (this._canceledDueToError) {
          err = this._canceledDueToError;
          this._canceledDueToError = false;
        }
        if (this.callback) {
          return this.callback(err);
        }
        this.emit("error", err);
      }
      handleReadyForQuery(con) {
        if (this._canceledDueToError) {
          return this.handleError(this._canceledDueToError, con);
        }
        if (this.callback) {
          try {
            this.callback(null, this._results);
          } catch (err) {
            process.nextTick(() => {
              throw err;
            });
          }
        }
        this.emit("end", this._results);
      }
      submit(connection) {
        if (typeof this.text !== "string" && typeof this.name !== "string") {
          return new Error("A query must have either text or a name. Supplying neither is unsupported.");
        }
        const previous = connection.parsedStatements[this.name] || connection.submittedNamedStatements[this.name];
        if (this.text && previous && this.text !== previous) {
          return new Error(`Prepared statements must be unique - '${this.name}' was used for a different statement`);
        }
        if (this.values && !Array.isArray(this.values)) {
          return new Error("Query values must be an array");
        }
        if (this.requiresPreparation()) {
          connection.stream.cork && connection.stream.cork();
          try {
            this.prepare(connection);
          } finally {
            connection.stream.uncork && connection.stream.uncork();
          }
        } else {
          connection.query(this.text);
        }
        return null;
      }
      hasBeenParsed(connection) {
        return this.name && (connection.parsedStatements[this.name] !== void 0 || connection.submittedNamedStatements[this.name] !== void 0);
      }
      handlePortalSuspended(connection) {
        this._getRows(connection, this.rows);
      }
      _getRows(connection, rows) {
        connection.execute({
          portal: this.portal,
          rows
        });
        if (!rows) {
          connection.sync();
        } else {
          connection.flush();
        }
      }
      // http://developer.postgresql.org/pgdocs/postgres/protocol-flow.html#PROTOCOL-FLOW-EXT-QUERY
      prepare(connection) {
        if (!this.hasBeenParsed(connection)) {
          connection.parse({
            text: this.text,
            name: this.name,
            types: this.types
          });
          if (this.name) {
            connection.submittedNamedStatements[this.name] = this.text;
          }
        }
        try {
          connection.bind({
            portal: this.portal,
            statement: this.name,
            values: this.values,
            binary: this.binary,
            valueMapper: utils.prepareValue
          });
        } catch (err) {
          connection.close({ type: "S", name: this.name });
          connection.sync();
          this.handleError(err, connection);
          return;
        }
        connection.describe({
          type: "P",
          name: this.portal || ""
        });
        this._getRows(connection, this.rows);
      }
      handleCopyInResponse(connection) {
        connection.sendCopyFail("No source stream defined");
      }
      handleCopyData(msg, connection) {
      }
    };
    module.exports = Query2;
  }
});

// scheduler/node_modules/pg-protocol/dist/messages.js
var require_messages = __commonJS({
  "scheduler/node_modules/pg-protocol/dist/messages.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.NoticeMessage = exports.DataRowMessage = exports.CommandCompleteMessage = exports.ReadyForQueryMessage = exports.NotificationResponseMessage = exports.BackendKeyDataMessage = exports.AuthenticationMD5Password = exports.ParameterStatusMessage = exports.ParameterDescriptionMessage = exports.RowDescriptionMessage = exports.Field = exports.CopyResponse = exports.CopyDataMessage = exports.DatabaseError = exports.copyDone = exports.emptyQuery = exports.replicationStart = exports.portalSuspended = exports.noData = exports.closeComplete = exports.bindComplete = exports.parseComplete = void 0;
    exports.parseComplete = {
      name: "parseComplete",
      length: 5
    };
    exports.bindComplete = {
      name: "bindComplete",
      length: 5
    };
    exports.closeComplete = {
      name: "closeComplete",
      length: 5
    };
    exports.noData = {
      name: "noData",
      length: 5
    };
    exports.portalSuspended = {
      name: "portalSuspended",
      length: 5
    };
    exports.replicationStart = {
      name: "replicationStart",
      length: 4
    };
    exports.emptyQuery = {
      name: "emptyQuery",
      length: 4
    };
    exports.copyDone = {
      name: "copyDone",
      length: 4
    };
    var DatabaseError2 = class extends Error {
      constructor(message, length, name) {
        super(message);
        this.length = length;
        this.name = name;
      }
    };
    exports.DatabaseError = DatabaseError2;
    var CopyDataMessage = class {
      constructor(length, chunk) {
        this.length = length;
        this.chunk = chunk;
        this.name = "copyData";
      }
    };
    exports.CopyDataMessage = CopyDataMessage;
    var CopyResponse = class {
      constructor(length, name, binary, columnCount) {
        this.length = length;
        this.name = name;
        this.binary = binary;
        this.columnTypes = new Array(columnCount);
      }
    };
    exports.CopyResponse = CopyResponse;
    var Field = class {
      constructor(name, tableID, columnID, dataTypeID, dataTypeSize, dataTypeModifier, format) {
        this.name = name;
        this.tableID = tableID;
        this.columnID = columnID;
        this.dataTypeID = dataTypeID;
        this.dataTypeSize = dataTypeSize;
        this.dataTypeModifier = dataTypeModifier;
        this.format = format;
      }
    };
    exports.Field = Field;
    var RowDescriptionMessage = class {
      constructor(length, fieldCount) {
        this.length = length;
        this.fieldCount = fieldCount;
        this.name = "rowDescription";
        this.fields = new Array(this.fieldCount);
      }
    };
    exports.RowDescriptionMessage = RowDescriptionMessage;
    var ParameterDescriptionMessage = class {
      constructor(length, parameterCount) {
        this.length = length;
        this.parameterCount = parameterCount;
        this.name = "parameterDescription";
        this.dataTypeIDs = new Array(this.parameterCount);
      }
    };
    exports.ParameterDescriptionMessage = ParameterDescriptionMessage;
    var ParameterStatusMessage = class {
      constructor(length, parameterName, parameterValue) {
        this.length = length;
        this.parameterName = parameterName;
        this.parameterValue = parameterValue;
        this.name = "parameterStatus";
      }
    };
    exports.ParameterStatusMessage = ParameterStatusMessage;
    var AuthenticationMD5Password = class {
      constructor(length, salt) {
        this.length = length;
        this.salt = salt;
        this.name = "authenticationMD5Password";
      }
    };
    exports.AuthenticationMD5Password = AuthenticationMD5Password;
    var BackendKeyDataMessage = class {
      constructor(length, processID, secretKey) {
        this.length = length;
        this.processID = processID;
        this.secretKey = secretKey;
        this.name = "backendKeyData";
      }
    };
    exports.BackendKeyDataMessage = BackendKeyDataMessage;
    var NotificationResponseMessage = class {
      constructor(length, processId, channel, payload) {
        this.length = length;
        this.processId = processId;
        this.channel = channel;
        this.payload = payload;
        this.name = "notification";
      }
    };
    exports.NotificationResponseMessage = NotificationResponseMessage;
    var ReadyForQueryMessage = class {
      constructor(length, status) {
        this.length = length;
        this.status = status;
        this.name = "readyForQuery";
      }
    };
    exports.ReadyForQueryMessage = ReadyForQueryMessage;
    var CommandCompleteMessage = class {
      constructor(length, text) {
        this.length = length;
        this.text = text;
        this.name = "commandComplete";
      }
    };
    exports.CommandCompleteMessage = CommandCompleteMessage;
    var DataRowMessage = class {
      constructor(length, fields) {
        this.length = length;
        this.fields = fields;
        this.name = "dataRow";
        this.fieldCount = fields.length;
      }
    };
    exports.DataRowMessage = DataRowMessage;
    var NoticeMessage = class {
      constructor(length, message) {
        this.length = length;
        this.message = message;
        this.name = "notice";
      }
    };
    exports.NoticeMessage = NoticeMessage;
  }
});

// scheduler/node_modules/pg-protocol/dist/buffer-writer.js
var require_buffer_writer = __commonJS({
  "scheduler/node_modules/pg-protocol/dist/buffer-writer.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.Writer = void 0;
    var Writer = class {
      constructor(size = 256) {
        this.size = size;
        this.offset = 5;
        this.headerPosition = 0;
        this.buffer = Buffer.allocUnsafe(size);
      }
      ensure(size) {
        const remaining = this.buffer.length - this.offset;
        if (remaining < size) {
          const oldBuffer = this.buffer;
          const newSize = oldBuffer.length + (oldBuffer.length >> 1) + size;
          this.buffer = Buffer.allocUnsafe(newSize);
          oldBuffer.copy(this.buffer, 0, 0, this.offset);
        }
      }
      addInt32(num2) {
        this.ensure(4);
        this.buffer[this.offset++] = num2 >>> 24 & 255;
        this.buffer[this.offset++] = num2 >>> 16 & 255;
        this.buffer[this.offset++] = num2 >>> 8 & 255;
        this.buffer[this.offset++] = num2 >>> 0 & 255;
        return this;
      }
      addInt16(num2) {
        this.ensure(2);
        this.buffer[this.offset++] = num2 >>> 8 & 255;
        this.buffer[this.offset++] = num2 >>> 0 & 255;
        return this;
      }
      addCString(string) {
        if (!string) {
          this.ensure(1);
        } else {
          const len = Buffer.byteLength(string);
          this.ensure(len + 1);
          this.buffer.write(string, this.offset, "utf-8");
          this.offset += len;
        }
        this.buffer[this.offset++] = 0;
        return this;
      }
      addString(string = "") {
        const len = Buffer.byteLength(string);
        this.ensure(len);
        this.buffer.write(string, this.offset);
        this.offset += len;
        return this;
      }
      // Write an Int32 byte-length prefix immediately followed by the string's UTF-8
      // bytes. Postgres' Bind wire format prefixes every parameter with its length,
      // and doing it in one method computes Buffer.byteLength ONCE — the previous
      // `addInt32(Buffer.byteLength(s)).addString(s)` pairing scanned the string
      // three times (byteLength for the prefix, byteLength again inside addString,
      // then the encode), which is costly for large text parameters.
      addInt32PrefixedString(string) {
        const len = Buffer.byteLength(string);
        this.ensure(4 + len);
        const buffer = this.buffer;
        let offset = this.offset;
        buffer[offset++] = len >>> 24 & 255;
        buffer[offset++] = len >>> 16 & 255;
        buffer[offset++] = len >>> 8 & 255;
        buffer[offset++] = len >>> 0 & 255;
        buffer.write(string, offset, "utf-8");
        this.offset = offset + len;
        return this;
      }
      add(otherBuffer) {
        this.ensure(otherBuffer.length);
        otherBuffer.copy(this.buffer, this.offset);
        this.offset += otherBuffer.length;
        return this;
      }
      /**
       * Appends an uninitialized block of {@link size} bytes to the buffer and returns its offset.
       */
      reserveUnsafe(size) {
        const offset = this.offset;
        this.ensure(size);
        this.offset += size;
        return offset;
      }
      join(code) {
        if (code) {
          this.buffer[this.headerPosition] = code;
          const length = this.offset - (this.headerPosition + 1);
          this.buffer.writeInt32BE(length, this.headerPosition + 1);
        }
        return this.buffer.slice(code ? 0 : 5, this.offset);
      }
      flush(code) {
        const result = this.join(code);
        this.offset = 5;
        this.headerPosition = 0;
        this.buffer = Buffer.allocUnsafe(this.size);
        return result;
      }
      clear() {
        this.offset = 5;
        this.headerPosition = 0;
      }
    };
    exports.Writer = Writer;
  }
});

// scheduler/node_modules/pg-protocol/dist/serializer.js
var require_serializer = __commonJS({
  "scheduler/node_modules/pg-protocol/dist/serializer.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.serialize = void 0;
    var buffer_writer_1 = require_buffer_writer();
    var writer = new buffer_writer_1.Writer();
    var startup = (opts) => {
      writer.addInt16(3).addInt16(0);
      for (const key of Object.keys(opts)) {
        writer.addCString(key).addCString(opts[key]);
      }
      writer.addCString("client_encoding").addCString("UTF8");
      const bodyBuffer = writer.addCString("").flush();
      const length = bodyBuffer.length + 4;
      return new buffer_writer_1.Writer().addInt32(length).add(bodyBuffer).flush();
    };
    var requestSsl = () => {
      const response = Buffer.allocUnsafe(8);
      response.writeInt32BE(8, 0);
      response.writeInt32BE(80877103, 4);
      return response;
    };
    var password = (password2) => {
      return writer.addCString(password2).flush(
        112
        /* code.startup */
      );
    };
    var sendSASLInitialResponseMessage = function(mechanism, initialResponse) {
      writer.addCString(mechanism).addInt32PrefixedString(initialResponse);
      return writer.flush(
        112
        /* code.startup */
      );
    };
    var sendSCRAMClientFinalMessage = function(additionalData) {
      return writer.addString(additionalData).flush(
        112
        /* code.startup */
      );
    };
    var query = (text) => {
      return writer.addCString(text).flush(
        81
        /* code.query */
      );
    };
    var emptyArray = [];
    var parse = (query2) => {
      const name = query2.name || "";
      if (name.length > 63) {
        console.error("Warning! Postgres only supports 63 characters for query names.");
        console.error("You supplied %s (%s)", name, name.length);
        console.error("This can cause conflicts and silent errors executing queries");
      }
      const types2 = query2.types || emptyArray;
      const len = types2.length;
      const buffer = writer.addCString(name).addCString(query2.text).addInt16(len);
      for (let i = 0; i < len; i++) {
        buffer.addInt32(types2[i]);
      }
      return writer.flush(
        80
        /* code.parse */
      );
    };
    var writeValues = function(values, valueMapper, formatsOffset) {
      const len = values.length;
      for (let i = 0; i < len; i++) {
        const mappedVal = valueMapper ? valueMapper(values[i], i) : values[i];
        let formatByte = 0;
        if (mappedVal == null) {
          writer.addInt32(-1);
        } else if (mappedVal instanceof Buffer) {
          formatByte = 1;
          writer.addInt32(mappedVal.length);
          writer.add(mappedVal);
        } else {
          writer.addInt32PrefixedString(mappedVal);
        }
        const buf = writer.buffer;
        buf[formatsOffset++] = 0;
        buf[formatsOffset++] = formatByte;
      }
    };
    var bind = (config2 = {}) => {
      const portal = config2.portal || "";
      const statement = config2.statement || "";
      const binary = config2.binary || false;
      const values = config2.values || emptyArray;
      const len = values.length;
      writer.addCString(portal).addCString(statement);
      writer.addInt16(len);
      const formatsOffset = writer.reserveUnsafe(len * 2);
      writer.addInt16(len);
      try {
        writeValues(values, config2.valueMapper, formatsOffset);
      } catch (err) {
        writer.clear();
        throw err;
      }
      writer.addInt16(1);
      writer.addInt16(
        binary ? 1 : 0
        /* ParamType.STRING */
      );
      return writer.flush(
        66
        /* code.bind */
      );
    };
    var emptyExecute = Buffer.from([69, 0, 0, 0, 9, 0, 0, 0, 0, 0]);
    var execute = (config2) => {
      if (!config2 || !config2.portal && !config2.rows) {
        return emptyExecute;
      }
      const portal = config2.portal || "";
      const rows = config2.rows || 0;
      const portalLength = Buffer.byteLength(portal);
      const len = 4 + portalLength + 1 + 4;
      const buff = Buffer.allocUnsafe(1 + len);
      buff[0] = 69;
      buff.writeInt32BE(len, 1);
      buff.write(portal, 5, "utf-8");
      buff[portalLength + 5] = 0;
      buff.writeUInt32BE(rows, buff.length - 4);
      return buff;
    };
    var cancel = (processID, secretKey) => {
      const buffer = Buffer.allocUnsafe(16);
      buffer.writeInt32BE(16, 0);
      buffer.writeInt16BE(1234, 4);
      buffer.writeInt16BE(5678, 6);
      buffer.writeInt32BE(processID, 8);
      buffer.writeInt32BE(secretKey, 12);
      return buffer;
    };
    var cstringMessage = (code, string) => {
      const stringLen = Buffer.byteLength(string);
      const len = 4 + stringLen + 1;
      const buffer = Buffer.allocUnsafe(1 + len);
      buffer[0] = code;
      buffer.writeInt32BE(len, 1);
      buffer.write(string, 5, "utf-8");
      buffer[len] = 0;
      return buffer;
    };
    var emptyDescribePortal = writer.addCString("P").flush(
      68
      /* code.describe */
    );
    var emptyDescribeStatement = writer.addCString("S").flush(
      68
      /* code.describe */
    );
    var describe = (msg) => {
      return msg.name ? cstringMessage(68, `${msg.type}${msg.name || ""}`) : msg.type === "P" ? emptyDescribePortal : emptyDescribeStatement;
    };
    var close = (msg) => {
      const text = `${msg.type}${msg.name || ""}`;
      return cstringMessage(67, text);
    };
    var copyData = (chunk) => {
      return writer.add(chunk).flush(
        100
        /* code.copyFromChunk */
      );
    };
    var copyFail = (message) => {
      return cstringMessage(102, message);
    };
    var codeOnlyBuffer = (code) => Buffer.from([code, 0, 0, 0, 4]);
    var flushBuffer = codeOnlyBuffer(
      72
      /* code.flush */
    );
    var syncBuffer = codeOnlyBuffer(
      83
      /* code.sync */
    );
    var endBuffer = codeOnlyBuffer(
      88
      /* code.end */
    );
    var copyDoneBuffer = codeOnlyBuffer(
      99
      /* code.copyDone */
    );
    var serialize = {
      startup,
      password,
      requestSsl,
      sendSASLInitialResponseMessage,
      sendSCRAMClientFinalMessage,
      query,
      parse,
      bind,
      execute,
      describe,
      close,
      flush: () => flushBuffer,
      sync: () => syncBuffer,
      end: () => endBuffer,
      copyData,
      copyDone: () => copyDoneBuffer,
      copyFail,
      cancel
    };
    exports.serialize = serialize;
  }
});

// scheduler/node_modules/pg-protocol/dist/buffer-reader.js
var require_buffer_reader = __commonJS({
  "scheduler/node_modules/pg-protocol/dist/buffer-reader.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.BufferReader = void 0;
    var BufferReader = class {
      constructor(offset = 0) {
        this.offset = offset;
        this.buffer = Buffer.allocUnsafe(0);
        this.encoding = "utf-8";
      }
      setBuffer(offset, buffer) {
        this.offset = offset;
        this.buffer = buffer;
      }
      int16() {
        const result = this.buffer.readInt16BE(this.offset);
        this.offset += 2;
        return result;
      }
      byte() {
        const result = this.buffer[this.offset];
        this.offset++;
        return result;
      }
      int32() {
        const result = this.buffer.readInt32BE(this.offset);
        this.offset += 4;
        return result;
      }
      uint32() {
        const result = this.buffer.readUInt32BE(this.offset);
        this.offset += 4;
        return result;
      }
      string(length) {
        const result = this.buffer.toString(this.encoding, this.offset, this.offset + length);
        this.offset += length;
        return result;
      }
      cstring() {
        const start = this.offset;
        let end = start;
        while (this.buffer[end++]) {
        }
        this.offset = end;
        return this.buffer.toString(this.encoding, start, end - 1);
      }
      bytes(length) {
        const result = this.buffer.slice(this.offset, this.offset + length);
        this.offset += length;
        return result;
      }
    };
    exports.BufferReader = BufferReader;
  }
});

// scheduler/node_modules/pg-protocol/dist/parser.js
var require_parser = __commonJS({
  "scheduler/node_modules/pg-protocol/dist/parser.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.Parser = void 0;
    var messages_1 = require_messages();
    var buffer_reader_1 = require_buffer_reader();
    var CODE_LENGTH = 1;
    var LEN_LENGTH = 4;
    var HEADER_LENGTH = CODE_LENGTH + LEN_LENGTH;
    var LATEINIT_LENGTH = -1;
    var emptyBuffer = Buffer.allocUnsafe(0);
    var Parser = class {
      constructor(opts) {
        this.buffer = emptyBuffer;
        this.bufferLength = 0;
        this.bufferOffset = 0;
        this.reader = new buffer_reader_1.BufferReader();
        if ((opts === null || opts === void 0 ? void 0 : opts.mode) === "binary") {
          throw new Error("Binary mode not supported yet");
        }
        this.mode = (opts === null || opts === void 0 ? void 0 : opts.mode) || "text";
      }
      parse(buffer, callback) {
        this.mergeBuffer(buffer);
        const bufferFullLength = this.bufferOffset + this.bufferLength;
        let offset = this.bufferOffset;
        while (offset + HEADER_LENGTH <= bufferFullLength) {
          const code = this.buffer[offset];
          const length = this.buffer.readUInt32BE(offset + CODE_LENGTH);
          const fullMessageLength = CODE_LENGTH + length;
          if (fullMessageLength + offset <= bufferFullLength) {
            const message = this.handlePacket(offset + HEADER_LENGTH, code, length, this.buffer);
            callback(message);
            offset += fullMessageLength;
          } else {
            break;
          }
        }
        if (offset === bufferFullLength) {
          this.buffer = emptyBuffer;
          this.bufferLength = 0;
          this.bufferOffset = 0;
        } else {
          this.bufferLength = bufferFullLength - offset;
          this.bufferOffset = offset;
        }
      }
      mergeBuffer(buffer) {
        if (this.bufferLength > 0) {
          const newLength = this.bufferLength + buffer.byteLength;
          const newFullLength = newLength + this.bufferOffset;
          if (newFullLength > this.buffer.byteLength) {
            let newBuffer;
            if (newLength <= this.buffer.byteLength && this.bufferOffset >= this.bufferLength) {
              newBuffer = this.buffer;
            } else {
              let newBufferLength = this.buffer.byteLength * 2;
              while (newLength >= newBufferLength) {
                newBufferLength *= 2;
              }
              newBuffer = Buffer.allocUnsafe(newBufferLength);
            }
            this.buffer.copy(newBuffer, 0, this.bufferOffset, this.bufferOffset + this.bufferLength);
            this.buffer = newBuffer;
            this.bufferOffset = 0;
          }
          buffer.copy(this.buffer, this.bufferOffset + this.bufferLength);
          this.bufferLength = newLength;
        } else {
          this.buffer = buffer;
          this.bufferOffset = 0;
          this.bufferLength = buffer.byteLength;
        }
      }
      handlePacket(offset, code, length, bytes) {
        const { reader } = this;
        reader.setBuffer(offset, bytes);
        let message;
        switch (code) {
          case 50:
            message = messages_1.bindComplete;
            break;
          case 49:
            message = messages_1.parseComplete;
            break;
          case 51:
            message = messages_1.closeComplete;
            break;
          case 110:
            message = messages_1.noData;
            break;
          case 115:
            message = messages_1.portalSuspended;
            break;
          case 99:
            message = messages_1.copyDone;
            break;
          case 87:
            message = messages_1.replicationStart;
            break;
          case 73:
            message = messages_1.emptyQuery;
            break;
          case 68:
            message = parseDataRowMessage(reader);
            break;
          case 67:
            message = parseCommandCompleteMessage(reader);
            break;
          case 90:
            message = parseReadyForQueryMessage(reader);
            break;
          case 65:
            message = parseNotificationMessage(reader);
            break;
          case 82:
            message = parseAuthenticationResponse(reader, length);
            break;
          case 83:
            message = parseParameterStatusMessage(reader);
            break;
          case 75:
            message = parseBackendKeyData(reader);
            break;
          case 69:
            message = parseErrorMessage(reader, "error");
            break;
          case 78:
            message = parseErrorMessage(reader, "notice");
            break;
          case 84:
            message = parseRowDescriptionMessage(reader);
            break;
          case 116:
            message = parseParameterDescriptionMessage(reader);
            break;
          case 71:
            message = parseCopyInMessage(reader);
            break;
          case 72:
            message = parseCopyOutMessage(reader);
            break;
          case 100:
            message = parseCopyData(reader, length);
            break;
          default:
            return new messages_1.DatabaseError("received invalid response: " + code.toString(16), length, "error");
        }
        reader.setBuffer(0, emptyBuffer);
        message.length = length;
        return message;
      }
    };
    exports.Parser = Parser;
    var parseReadyForQueryMessage = (reader) => {
      const status = reader.string(1);
      return new messages_1.ReadyForQueryMessage(LATEINIT_LENGTH, status);
    };
    var parseCommandCompleteMessage = (reader) => {
      const text = reader.cstring();
      return new messages_1.CommandCompleteMessage(LATEINIT_LENGTH, text);
    };
    var parseCopyData = (reader, length) => {
      const chunk = reader.bytes(length - 4);
      return new messages_1.CopyDataMessage(LATEINIT_LENGTH, chunk);
    };
    var parseCopyInMessage = (reader) => parseCopyMessage(reader, "copyInResponse");
    var parseCopyOutMessage = (reader) => parseCopyMessage(reader, "copyOutResponse");
    var parseCopyMessage = (reader, messageName) => {
      const isBinary = reader.byte() !== 0;
      const columnCount = reader.int16();
      const message = new messages_1.CopyResponse(LATEINIT_LENGTH, messageName, isBinary, columnCount);
      for (let i = 0; i < columnCount; i++) {
        message.columnTypes[i] = reader.int16();
      }
      return message;
    };
    var parseNotificationMessage = (reader) => {
      const processId = reader.int32();
      const channel = reader.cstring();
      const payload = reader.cstring();
      return new messages_1.NotificationResponseMessage(LATEINIT_LENGTH, processId, channel, payload);
    };
    var parseRowDescriptionMessage = (reader) => {
      const fieldCount = reader.int16();
      const message = new messages_1.RowDescriptionMessage(LATEINIT_LENGTH, fieldCount);
      for (let i = 0; i < fieldCount; i++) {
        message.fields[i] = parseField(reader);
      }
      return message;
    };
    var parseField = (reader) => {
      const name = reader.cstring();
      const tableID = reader.uint32();
      const columnID = reader.int16();
      const dataTypeID = reader.uint32();
      const dataTypeSize = reader.int16();
      const dataTypeModifier = reader.int32();
      const mode = reader.int16() === 0 ? "text" : "binary";
      return new messages_1.Field(name, tableID, columnID, dataTypeID, dataTypeSize, dataTypeModifier, mode);
    };
    var parseParameterDescriptionMessage = (reader) => {
      const parameterCount = reader.int16();
      const message = new messages_1.ParameterDescriptionMessage(LATEINIT_LENGTH, parameterCount);
      for (let i = 0; i < parameterCount; i++) {
        message.dataTypeIDs[i] = reader.uint32();
      }
      return message;
    };
    var parseDataRowMessage = (reader) => {
      const fieldCount = reader.int16();
      const fields = new Array(fieldCount);
      for (let i = 0; i < fieldCount; i++) {
        const len = reader.int32();
        fields[i] = len === -1 ? null : reader.string(len);
      }
      return new messages_1.DataRowMessage(LATEINIT_LENGTH, fields);
    };
    var parseParameterStatusMessage = (reader) => {
      const name = reader.cstring();
      const value = reader.cstring();
      return new messages_1.ParameterStatusMessage(LATEINIT_LENGTH, name, value);
    };
    var parseBackendKeyData = (reader) => {
      const processID = reader.int32();
      const secretKey = reader.int32();
      return new messages_1.BackendKeyDataMessage(LATEINIT_LENGTH, processID, secretKey);
    };
    var parseAuthenticationResponse = (reader, length) => {
      const code = reader.int32();
      const message = {
        name: "authenticationOk",
        length
      };
      switch (code) {
        case 0:
          break;
        case 3:
          if (message.length === 8) {
            message.name = "authenticationCleartextPassword";
          }
          break;
        case 5:
          if (message.length === 12) {
            message.name = "authenticationMD5Password";
            const salt = reader.bytes(4);
            return new messages_1.AuthenticationMD5Password(LATEINIT_LENGTH, salt);
          }
          break;
        case 10:
          {
            message.name = "authenticationSASL";
            message.mechanisms = [];
            let mechanism;
            do {
              mechanism = reader.cstring();
              if (mechanism) {
                message.mechanisms.push(mechanism);
              }
            } while (mechanism);
          }
          break;
        case 11:
          message.name = "authenticationSASLContinue";
          message.data = reader.string(length - 8);
          break;
        case 12:
          message.name = "authenticationSASLFinal";
          message.data = reader.string(length - 8);
          break;
        default:
          throw new Error("Unknown authenticationOk message type " + code);
      }
      return message;
    };
    var parseErrorMessage = (reader, name) => {
      const fields = {};
      let fieldType = reader.string(1);
      while (fieldType !== "\0") {
        fields[fieldType] = reader.cstring();
        fieldType = reader.string(1);
      }
      const messageValue = fields.M;
      const message = name === "notice" ? new messages_1.NoticeMessage(LATEINIT_LENGTH, messageValue) : new messages_1.DatabaseError(messageValue, LATEINIT_LENGTH, name);
      message.severity = fields.S;
      message.code = fields.C;
      message.detail = fields.D;
      message.hint = fields.H;
      message.position = fields.P;
      message.internalPosition = fields.p;
      message.internalQuery = fields.q;
      message.where = fields.W;
      message.schema = fields.s;
      message.table = fields.t;
      message.column = fields.c;
      message.dataType = fields.d;
      message.constraint = fields.n;
      message.file = fields.F;
      message.line = fields.L;
      message.routine = fields.R;
      return message;
    };
  }
});

// scheduler/node_modules/pg-protocol/dist/index.js
var require_dist = __commonJS({
  "scheduler/node_modules/pg-protocol/dist/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.DatabaseError = exports.serialize = void 0;
    exports.parse = parse;
    var messages_1 = require_messages();
    Object.defineProperty(exports, "DatabaseError", { enumerable: true, get: function() {
      return messages_1.DatabaseError;
    } });
    var serializer_1 = require_serializer();
    Object.defineProperty(exports, "serialize", { enumerable: true, get: function() {
      return serializer_1.serialize;
    } });
    var parser_1 = require_parser();
    function parse(stream, callback) {
      const parser = new parser_1.Parser();
      stream.on("data", (buffer) => parser.parse(buffer, callback));
      return new Promise((resolve) => stream.on("end", () => resolve()));
    }
  }
});

// scheduler/node_modules/pg-cloudflare/dist/empty.js
var require_empty = __commonJS({
  "scheduler/node_modules/pg-cloudflare/dist/empty.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.default = {};
  }
});

// scheduler/node_modules/pg/lib/stream.js
var require_stream = __commonJS({
  "scheduler/node_modules/pg/lib/stream.js"(exports, module) {
    var { getStream, getSecureStream } = getStreamFuncs();
    module.exports = {
      /**
       * Get a socket stream compatible with the current runtime environment.
       * @returns {Duplex}
       */
      getStream,
      /**
       * Get a TLS secured socket, compatible with the current environment,
       * using the socket and other settings given in `options`.
       * @returns {Duplex}
       */
      getSecureStream
    };
    function getNodejsStreamFuncs() {
      function getStream2(ssl) {
        const net = __require("net");
        return new net.Socket();
      }
      function getSecureStream2(options) {
        const tls = __require("tls");
        return tls.connect(options);
      }
      return {
        getStream: getStream2,
        getSecureStream: getSecureStream2
      };
    }
    function getCloudflareStreamFuncs() {
      function getStream2(ssl) {
        const { CloudflareSocket } = require_empty();
        return new CloudflareSocket(ssl);
      }
      function getSecureStream2(options) {
        options.socket.startTls(options);
        return options.socket;
      }
      return {
        getStream: getStream2,
        getSecureStream: getSecureStream2
      };
    }
    function isCloudflareRuntime() {
      if (typeof navigator === "object" && navigator !== null && typeof navigator.userAgent === "string") {
        return navigator.userAgent === "Cloudflare-Workers";
      }
      if (typeof Response === "function") {
        const resp = new Response(null, { cf: { thing: true } });
        if (typeof resp.cf === "object" && resp.cf !== null && resp.cf.thing) {
          return true;
        }
      }
      return false;
    }
    function getStreamFuncs() {
      if (isCloudflareRuntime()) {
        return getCloudflareStreamFuncs();
      }
      return getNodejsStreamFuncs();
    }
  }
});

// scheduler/node_modules/pg/lib/connection.js
var require_connection = __commonJS({
  "scheduler/node_modules/pg/lib/connection.js"(exports, module) {
    "use strict";
    var EventEmitter = __require("events").EventEmitter;
    var { parse, serialize } = require_dist();
    var stream = require_stream();
    var { getStream } = stream;
    var flushBuffer = serialize.flush();
    var syncBuffer = serialize.sync();
    var endBuffer = serialize.end();
    var Connection2 = class extends EventEmitter {
      constructor(config2) {
        super();
        config2 = config2 || {};
        this.stream = config2.stream || getStream(config2.ssl);
        if (typeof this.stream === "function") {
          this.stream = this.stream(config2);
        }
        this._keepAlive = config2.keepAlive;
        this._keepAliveInitialDelayMillis = config2.keepAliveInitialDelayMillis;
        this.parsedStatements = {};
        this.submittedNamedStatements = {};
        this.ssl = config2.ssl || false;
        this.sslNegotiation = config2.sslNegotiation || "postgres";
        this._ending = false;
        this._emitMessage = false;
        const self = this;
        this.on("newListener", function(eventName) {
          if (eventName === "message") {
            self._emitMessage = true;
          }
        });
      }
      connect(port, host) {
        const self = this;
        this._connecting = true;
        this.stream.setNoDelay(true);
        this.stream.connect(port, host);
        this.stream.once("connect", function() {
          if (self._keepAlive) {
            self.stream.setKeepAlive(true, self._keepAliveInitialDelayMillis);
          }
          self.emit("connect");
        });
        const reportStreamError = function(error) {
          if (self._ending && (error.code === "ECONNRESET" || error.code === "EPIPE")) {
            return;
          }
          self.emit("error", error);
        };
        this.stream.on("error", reportStreamError);
        this.stream.on("close", function() {
          self.emit("end");
        });
        if (!this.ssl) {
          return this.attachListeners(this.stream);
        }
        if (this.sslNegotiation === "direct") {
          return this.stream.once("connect", function() {
            self.upgradeToSSL(host, reportStreamError);
          });
        }
        this.stream.once("data", function(buffer) {
          const responseCode = buffer.toString("utf8");
          switch (responseCode) {
            case "S":
              break;
            case "N":
              self.stream.end();
              return self.emit("error", new Error("The server does not support SSL connections"));
            default:
              self.stream.end();
              return self.emit("error", new Error("There was an error establishing an SSL connection"));
          }
          self.upgradeToSSL(host, reportStreamError);
        });
      }
      upgradeToSSL(host, reportStreamError) {
        const self = this;
        const options = {
          socket: self.stream,
          // tls.connect checks the server identity against `servername`, falling
          // back to `host` and then to 'localhost'. `servername` must stay unset
          // for IP addresses (see below), so `host` is needed to keep certificate
          // validation working when connecting to an IP address.
          host
        };
        if (self.ssl !== true) {
          Object.assign(options, self.ssl);
          if ("key" in self.ssl) {
            options.key = self.ssl.key;
          }
        }
        if (self.sslNegotiation === "direct") {
          options.ALPNProtocols = ["postgresql"];
        }
        const net = __require("net");
        if (net.isIP && net.isIP(host) === 0) {
          options.servername = host;
        }
        try {
          self.stream = stream.getSecureStream(options);
        } catch (err) {
          return self.emit("error", err);
        }
        self.attachListeners(self.stream);
        self.stream.on("error", reportStreamError);
        self.emit("sslconnect");
      }
      attachListeners(stream2) {
        parse(stream2, (msg) => {
          const eventName = msg.name === "error" ? "errorMessage" : msg.name;
          if (this._emitMessage) {
            this.emit("message", msg);
          }
          this.emit(eventName, msg);
        });
      }
      requestSsl() {
        this.stream.write(serialize.requestSsl());
      }
      startup(config2) {
        this.stream.write(serialize.startup(config2));
      }
      cancel(processID, secretKey) {
        this._send(serialize.cancel(processID, secretKey));
      }
      password(password) {
        this._send(serialize.password(password));
      }
      sendSASLInitialResponseMessage(mechanism, initialResponse) {
        this._send(serialize.sendSASLInitialResponseMessage(mechanism, initialResponse));
      }
      sendSCRAMClientFinalMessage(additionalData) {
        this._send(serialize.sendSCRAMClientFinalMessage(additionalData));
      }
      _send(buffer) {
        if (!this.stream.writable) {
          return false;
        }
        return this.stream.write(buffer);
      }
      query(text) {
        this._send(serialize.query(text));
      }
      // send parse message
      parse(query) {
        this._send(serialize.parse(query));
      }
      // send bind message
      bind(config2) {
        this._send(serialize.bind(config2));
      }
      // send execute message
      execute(config2) {
        this._send(serialize.execute(config2));
      }
      flush() {
        if (this.stream.writable) {
          this.stream.write(flushBuffer);
        }
      }
      sync() {
        this._send(syncBuffer);
      }
      ref() {
        this.stream.ref();
      }
      unref() {
        this.stream.unref();
      }
      end() {
        this._ending = true;
        if (!this._connecting || !this.stream.writable) {
          this.stream.end();
          return;
        }
        return this.stream.write(endBuffer, () => {
          this.stream.end();
        });
      }
      close(msg) {
        this._send(serialize.close(msg));
      }
      describe(msg) {
        this._send(serialize.describe(msg));
      }
      sendCopyFromChunk(chunk) {
        this._send(serialize.copyData(chunk));
      }
      endCopyFrom() {
        this._send(serialize.copyDone());
      }
      sendCopyFail(msg) {
        this._send(serialize.copyFail(msg));
      }
    };
    module.exports = Connection2;
  }
});

// scheduler/node_modules/split2/index.js
var require_split2 = __commonJS({
  "scheduler/node_modules/split2/index.js"(exports, module) {
    "use strict";
    var { Transform } = __require("stream");
    var { StringDecoder } = __require("string_decoder");
    var kLast = /* @__PURE__ */ Symbol("last");
    var kDecoder = /* @__PURE__ */ Symbol("decoder");
    function transform(chunk, enc, cb) {
      let list;
      if (this.overflow) {
        const buf = this[kDecoder].write(chunk);
        list = buf.split(this.matcher);
        if (list.length === 1) return cb();
        list.shift();
        this.overflow = false;
      } else {
        this[kLast] += this[kDecoder].write(chunk);
        list = this[kLast].split(this.matcher);
      }
      this[kLast] = list.pop();
      for (let i = 0; i < list.length; i++) {
        try {
          push(this, this.mapper(list[i]));
        } catch (error) {
          return cb(error);
        }
      }
      this.overflow = this[kLast].length > this.maxLength;
      if (this.overflow && !this.skipOverflow) {
        cb(new Error("maximum buffer reached"));
        return;
      }
      cb();
    }
    function flush(cb) {
      this[kLast] += this[kDecoder].end();
      if (this[kLast]) {
        try {
          push(this, this.mapper(this[kLast]));
        } catch (error) {
          return cb(error);
        }
      }
      cb();
    }
    function push(self, val) {
      if (val !== void 0) {
        self.push(val);
      }
    }
    function noop(incoming) {
      return incoming;
    }
    function split(matcher, mapper, options) {
      matcher = matcher || /\r?\n/;
      mapper = mapper || noop;
      options = options || {};
      switch (arguments.length) {
        case 1:
          if (typeof matcher === "function") {
            mapper = matcher;
            matcher = /\r?\n/;
          } else if (typeof matcher === "object" && !(matcher instanceof RegExp) && !matcher[Symbol.split]) {
            options = matcher;
            matcher = /\r?\n/;
          }
          break;
        case 2:
          if (typeof matcher === "function") {
            options = mapper;
            mapper = matcher;
            matcher = /\r?\n/;
          } else if (typeof mapper === "object") {
            options = mapper;
            mapper = noop;
          }
      }
      options = Object.assign({}, options);
      options.autoDestroy = true;
      options.transform = transform;
      options.flush = flush;
      options.readableObjectMode = true;
      const stream = new Transform(options);
      stream[kLast] = "";
      stream[kDecoder] = new StringDecoder("utf8");
      stream.matcher = matcher;
      stream.mapper = mapper;
      stream.maxLength = options.maxLength;
      stream.skipOverflow = options.skipOverflow || false;
      stream.overflow = false;
      stream._destroy = function(err, cb) {
        this._writableState.errorEmitted = false;
        cb(err);
      };
      return stream;
    }
    module.exports = split;
  }
});

// scheduler/node_modules/pgpass/lib/helper.js
var require_helper = __commonJS({
  "scheduler/node_modules/pgpass/lib/helper.js"(exports, module) {
    "use strict";
    var path2 = __require("path");
    var Stream = __require("stream").Stream;
    var split = require_split2();
    var util = __require("util");
    var defaultPort = 5432;
    var isWin = process.platform === "win32";
    var warnStream = process.stderr;
    var S_IRWXG = 56;
    var S_IRWXO = 7;
    var S_IFMT = 61440;
    var S_IFREG = 32768;
    function isRegFile(mode) {
      return (mode & S_IFMT) == S_IFREG;
    }
    var fieldNames = ["host", "port", "database", "user", "password"];
    var nrOfFields = fieldNames.length;
    var passKey = fieldNames[nrOfFields - 1];
    function warn() {
      var isWritable = warnStream instanceof Stream && true === warnStream.writable;
      if (isWritable) {
        var args = Array.prototype.slice.call(arguments).concat("\n");
        warnStream.write(util.format.apply(util, args));
      }
    }
    Object.defineProperty(module.exports, "isWin", {
      get: function() {
        return isWin;
      },
      set: function(val) {
        isWin = val;
      }
    });
    module.exports.warnTo = function(stream) {
      var old = warnStream;
      warnStream = stream;
      return old;
    };
    module.exports.getFileName = function(rawEnv) {
      var env = rawEnv || process.env;
      var file = env.PGPASSFILE || (isWin ? path2.join(env.APPDATA || "./", "postgresql", "pgpass.conf") : path2.join(env.HOME || "./", ".pgpass"));
      return file;
    };
    module.exports.usePgPass = function(stats, fname) {
      if (Object.prototype.hasOwnProperty.call(process.env, "PGPASSWORD")) {
        return false;
      }
      if (isWin) {
        return true;
      }
      fname = fname || "<unkn>";
      if (!isRegFile(stats.mode)) {
        warn('WARNING: password file "%s" is not a plain file', fname);
        return false;
      }
      if (stats.mode & (S_IRWXG | S_IRWXO)) {
        warn('WARNING: password file "%s" has group or world access; permissions should be u=rw (0600) or less', fname);
        return false;
      }
      return true;
    };
    var matcher = module.exports.match = function(connInfo, entry) {
      return fieldNames.slice(0, -1).reduce(function(prev, field, idx) {
        if (idx == 1) {
          if (Number(connInfo[field] || defaultPort) === Number(entry[field])) {
            return prev && true;
          }
        }
        return prev && (entry[field] === "*" || entry[field] === connInfo[field]);
      }, true);
    };
    module.exports.getPassword = function(connInfo, stream, cb) {
      var pass;
      var lineStream = stream.pipe(split());
      function onLine(line) {
        var entry = parseLine(line);
        if (entry && isValidEntry(entry) && matcher(connInfo, entry)) {
          pass = entry[passKey];
          lineStream.end();
        }
      }
      var onEnd = function() {
        stream.destroy();
        cb(pass);
      };
      var onErr = function(err) {
        stream.destroy();
        warn("WARNING: error on reading file: %s", err);
        cb(void 0);
      };
      stream.on("error", onErr);
      lineStream.on("data", onLine).on("end", onEnd).on("error", onErr);
    };
    var parseLine = module.exports.parseLine = function(line) {
      if (line.length < 11 || line.match(/^\s+#/)) {
        return null;
      }
      var curChar = "";
      var prevChar = "";
      var fieldIdx = 0;
      var startIdx = 0;
      var endIdx = 0;
      var obj = {};
      var isLastField = false;
      var addToObj = function(idx, i0, i1) {
        var field = line.substring(i0, i1);
        if (!Object.hasOwnProperty.call(process.env, "PGPASS_NO_DEESCAPE")) {
          field = field.replace(/\\([:\\])/g, "$1");
        }
        obj[fieldNames[idx]] = field;
      };
      for (var i = 0; i < line.length - 1; i += 1) {
        curChar = line.charAt(i + 1);
        prevChar = line.charAt(i);
        isLastField = fieldIdx == nrOfFields - 1;
        if (isLastField) {
          addToObj(fieldIdx, startIdx);
          break;
        }
        if (i >= 0 && curChar == ":" && prevChar !== "\\") {
          addToObj(fieldIdx, startIdx, i + 1);
          startIdx = i + 2;
          fieldIdx += 1;
        }
      }
      obj = Object.keys(obj).length === nrOfFields ? obj : null;
      return obj;
    };
    var isValidEntry = module.exports.isValidEntry = function(entry) {
      var rules = {
        // host
        0: function(x) {
          return x.length > 0;
        },
        // port
        1: function(x) {
          if (x === "*") {
            return true;
          }
          x = Number(x);
          return isFinite(x) && x > 0 && x < 9007199254740992 && Math.floor(x) === x;
        },
        // database
        2: function(x) {
          return x.length > 0;
        },
        // username
        3: function(x) {
          return x.length > 0;
        },
        // password
        4: function(x) {
          return x.length > 0;
        }
      };
      for (var idx = 0; idx < fieldNames.length; idx += 1) {
        var rule = rules[idx];
        var value = entry[fieldNames[idx]] || "";
        var res = rule(value);
        if (!res) {
          return false;
        }
      }
      return true;
    };
  }
});

// scheduler/node_modules/pgpass/lib/index.js
var require_lib = __commonJS({
  "scheduler/node_modules/pgpass/lib/index.js"(exports, module) {
    "use strict";
    var path2 = __require("path");
    var fs4 = __require("fs");
    var helper = require_helper();
    module.exports = function(connInfo, cb) {
      var file = helper.getFileName();
      fs4.stat(file, function(err, stat) {
        if (err || !helper.usePgPass(stat, file)) {
          return cb(void 0);
        }
        var st = fs4.createReadStream(file);
        helper.getPassword(connInfo, st, cb);
      });
    };
    module.exports.warnTo = helper.warnTo;
  }
});

// scheduler/node_modules/pg/lib/client.js
var require_client = __commonJS({
  "scheduler/node_modules/pg/lib/client.js"(exports, module) {
    var EventEmitter = __require("events").EventEmitter;
    var utils = require_utils();
    var nodeUtils = __require("util");
    var sasl = require_sasl();
    var TypeOverrides2 = require_type_overrides();
    var ConnectionParameters = require_connection_parameters();
    var Query2 = require_query();
    var defaults2 = require_defaults();
    var Connection2 = require_connection();
    var crypto = require_utils2();
    var activeQueryDeprecationNotice = nodeUtils.deprecate(
      () => {
      },
      "Client.activeQuery is deprecated and will be removed in pg@9.0"
    );
    var queryQueueDeprecationNotice = nodeUtils.deprecate(
      () => {
      },
      "Client.queryQueue is deprecated and will be removed in pg@9.0."
    );
    var pgPassDeprecationNotice = nodeUtils.deprecate(
      () => {
      },
      "pgpass support is deprecated and will be removed in pg@9.0. You can provide an async function as the password property to the Client/Pool constructor that returns a password instead. Within this function you can call the pgpass module in your own code."
    );
    var byoPromiseDeprecationNotice = nodeUtils.deprecate(
      () => {
      },
      "Passing a custom Promise implementation to the Client/Pool constructor is deprecated and will be removed in pg@9.0."
    );
    var queryQueueLengthDeprecationNotice = nodeUtils.deprecate(
      () => {
      },
      "Calling client.query() when the client is already executing a query is deprecated and will be removed in pg@9.0. Use async/await or an external async flow control mechanism instead."
    );
    function coerceNumberOrDefault(value, defaultValue) {
      if (typeof value === "number") {
        return Number.isFinite(value) ? value : defaultValue;
      }
      if (typeof value === "string" && value.trim() !== "") {
        const n2 = Number(value);
        return Number.isFinite(n2) ? n2 : defaultValue;
      }
      return defaultValue;
    }
    var Client2 = class extends EventEmitter {
      constructor(config2) {
        super();
        this.connectionParameters = new ConnectionParameters(config2);
        this.user = this.connectionParameters.user;
        this.database = this.connectionParameters.database;
        this.port = this.connectionParameters.port;
        this.host = this.connectionParameters.host;
        Object.defineProperty(this, "password", {
          configurable: true,
          enumerable: false,
          writable: true,
          value: this.connectionParameters.password
        });
        this.replication = this.connectionParameters.replication;
        const c = config2 || {};
        if (c.Promise) {
          byoPromiseDeprecationNotice();
        }
        this._Promise = c.Promise || global.Promise;
        this._types = new TypeOverrides2(c.types);
        this._ending = false;
        this._ended = false;
        this._connecting = false;
        this._connected = false;
        this._connectionError = false;
        this._queryable = true;
        this._activeQuery = null;
        this._txStatus = null;
        this.enableChannelBinding = Boolean(c.enableChannelBinding);
        this.scramMaxIterations = coerceNumberOrDefault(c.scramMaxIterations, sasl.DEFAULT_MAX_SCRAM_ITERATIONS);
        this.connection = c.connection || new Connection2({
          stream: c.stream,
          ssl: this.connectionParameters.ssl,
          sslNegotiation: this.connectionParameters.sslnegotiation,
          keepAlive: c.keepAlive || false,
          keepAliveInitialDelayMillis: c.keepAliveInitialDelayMillis || 0,
          encoding: this.connectionParameters.client_encoding || "utf8"
        });
        this._queryQueue = [];
        this._sentQueryQueue = [];
        this.pipeline = Boolean(c.pipeline);
        this.binary = c.binary || defaults2.binary;
        this.processID = null;
        this.secretKey = null;
        this.ssl = this.connectionParameters.ssl || false;
        this.sslNegotiation = this.connectionParameters.sslnegotiation || "postgres";
        if (this.ssl && this.ssl.key) {
          Object.defineProperty(this.ssl, "key", {
            enumerable: false
          });
        }
        this._connectionTimeoutMillis = c.connectionTimeoutMillis || 0;
      }
      get activeQuery() {
        activeQueryDeprecationNotice();
        return this._activeQuery;
      }
      set activeQuery(val) {
        activeQueryDeprecationNotice();
        this._activeQuery = val;
      }
      _getActiveQuery() {
        return this._activeQuery;
      }
      _errorAllQueries(err) {
        const enqueueError = (query) => {
          process.nextTick(() => {
            query.handleError(err, this.connection);
          });
        };
        const activeQuery = this._getActiveQuery();
        if (activeQuery) {
          enqueueError(activeQuery);
          this._activeQuery = null;
        }
        this._sentQueryQueue.forEach(enqueueError);
        this._sentQueryQueue.length = 0;
        this._queryQueue.forEach(enqueueError);
        this._queryQueue.length = 0;
      }
      _connect(callback) {
        const self = this;
        const con = this.connection;
        this._connectionCallback = callback;
        if (this._connecting || this._connected) {
          const err = new Error("Client has already been connected. You cannot reuse a client.");
          process.nextTick(() => {
            callback(err);
          });
          return;
        }
        this._connecting = true;
        if (this._connectionTimeoutMillis > 0) {
          this.connectionTimeoutHandle = setTimeout(() => {
            con._ending = true;
            con.stream.destroy(new Error("timeout expired"));
          }, this._connectionTimeoutMillis);
          if (this.connectionTimeoutHandle.unref) {
            this.connectionTimeoutHandle.unref();
          }
        }
        if (this.host && this.host.indexOf("/") === 0) {
          con.connect(this.host + "/.s.PGSQL." + this.port);
        } else {
          con.connect(this.port, this.host);
        }
        con.on("connect", function() {
          if (self.ssl) {
            if (self.sslNegotiation !== "direct") {
              con.requestSsl();
            }
          } else {
            con.startup(self.getStartupConf());
          }
        });
        con.on("sslconnect", function() {
          con.startup(self.getStartupConf());
        });
        this._attachListeners(con);
        con.once("end", () => {
          const error = this._ending ? new Error("Connection terminated") : new Error("Connection terminated unexpectedly");
          clearTimeout(this.connectionTimeoutHandle);
          this._errorAllQueries(error);
          this._ended = true;
          if (!this._ending) {
            if (this._connecting && !this._connectionError) {
              if (this._connectionCallback) {
                this._connectionCallback(error);
              } else {
                this._handleErrorEvent(error);
              }
            } else if (!this._connectionError) {
              this._handleErrorEvent(error);
            }
          }
          process.nextTick(() => {
            this.emit("end");
          });
        });
      }
      connect(callback) {
        if (callback) {
          this._connect(callback);
          return;
        }
        return new this._Promise((resolve, reject) => {
          this._connect((error) => {
            if (error) {
              reject(error);
            } else {
              resolve(this);
            }
          });
        });
      }
      _attachListeners(con) {
        con.on("authenticationCleartextPassword", this._handleAuthCleartextPassword.bind(this));
        con.on("authenticationMD5Password", this._handleAuthMD5Password.bind(this));
        con.on("authenticationSASL", this._handleAuthSASL.bind(this));
        con.on("authenticationSASLContinue", this._handleAuthSASLContinue.bind(this));
        con.on("authenticationSASLFinal", this._handleAuthSASLFinal.bind(this));
        con.on("backendKeyData", this._handleBackendKeyData.bind(this));
        con.on("error", this._handleErrorEvent.bind(this));
        con.on("errorMessage", this._handleErrorMessage.bind(this));
        con.on("readyForQuery", this._handleReadyForQuery.bind(this));
        con.on("notice", this._handleNotice.bind(this));
        con.on("rowDescription", this._handleRowDescription.bind(this));
        con.on("dataRow", this._handleDataRow.bind(this));
        con.on("portalSuspended", this._handlePortalSuspended.bind(this));
        con.on("emptyQuery", this._handleEmptyQuery.bind(this));
        con.on("commandComplete", this._handleCommandComplete.bind(this));
        con.on("parseComplete", this._handleParseComplete.bind(this));
        con.on("copyInResponse", this._handleCopyInResponse.bind(this));
        con.on("copyData", this._handleCopyData.bind(this));
        con.on("notification", this._handleNotification.bind(this));
      }
      _getPassword(cb) {
        const con = this.connection;
        if (typeof this.password === "function") {
          this._Promise.resolve().then(() => this.password(this.connectionParameters)).then((pass) => {
            if (pass !== void 0) {
              if (typeof pass !== "string") {
                con.emit("error", new TypeError("Password must be a string"));
                return;
              }
              this.connectionParameters.password = this.password = pass;
            } else {
              this.connectionParameters.password = this.password = null;
            }
            cb();
          }).catch((err) => {
            con.emit("error", err);
          });
        } else if (this.password !== null) {
          cb();
        } else {
          try {
            const pgPass = require_lib();
            pgPass(this.connectionParameters, (pass) => {
              if (void 0 !== pass) {
                pgPassDeprecationNotice();
                this.connectionParameters.password = this.password = pass;
              }
              cb();
            });
          } catch (e) {
            this.emit("error", e);
          }
        }
      }
      _handleAuthCleartextPassword(msg) {
        this._getPassword(() => {
          this.connection.password(this.password);
        });
      }
      _handleAuthMD5Password(msg) {
        this._getPassword(async () => {
          try {
            const hashedPassword = await crypto.postgresMd5PasswordHash(this.user, this.password, msg.salt);
            this.connection.password(hashedPassword);
          } catch (e) {
            this.emit("error", e);
          }
        });
      }
      _handleAuthSASL(msg) {
        this._getPassword(() => {
          try {
            this.saslSession = sasl.startSession(
              msg.mechanisms,
              this.enableChannelBinding && this.connection.stream,
              this.scramMaxIterations
            );
            this.connection.sendSASLInitialResponseMessage(this.saslSession.mechanism, this.saslSession.response);
          } catch (err) {
            this.connection.emit("error", err);
          }
        });
      }
      async _handleAuthSASLContinue(msg) {
        try {
          await sasl.continueSession(
            this.saslSession,
            this.password,
            msg.data,
            this.enableChannelBinding && this.connection.stream
          );
          this.connection.sendSCRAMClientFinalMessage(this.saslSession.response);
        } catch (err) {
          this.connection.emit("error", err);
        }
      }
      _handleAuthSASLFinal(msg) {
        try {
          sasl.finalizeSession(this.saslSession, msg.data);
          this.saslSession = null;
        } catch (err) {
          this.connection.emit("error", err);
        }
      }
      _handleBackendKeyData(msg) {
        this.processID = msg.processID;
        this.secretKey = msg.secretKey;
      }
      _handleReadyForQuery(msg) {
        if (this._connecting) {
          this._connecting = false;
          this._connected = true;
          clearTimeout(this.connectionTimeoutHandle);
          if (this._connectionCallback) {
            this._connectionCallback(null, this);
            this._connectionCallback = null;
          }
          this.emit("connect");
        }
        const activeQuery = this._getActiveQuery();
        this._activeQuery = null;
        this._txStatus = msg?.status ?? null;
        this.readyForQuery = true;
        if (activeQuery) {
          activeQuery.handleReadyForQuery(this.connection);
        }
        this._pulseQueryQueue();
      }
      // if we receive an error event or error message
      // during the connection process we handle it here
      _handleErrorWhileConnecting(err) {
        if (this._connectionError) {
          return;
        }
        this._connectionError = true;
        clearTimeout(this.connectionTimeoutHandle);
        if (this._connectionCallback) {
          return this._connectionCallback(err);
        }
        this.emit("error", err);
      }
      // if we're connected and we receive an error event from the connection
      // this means the socket is dead - do a hard abort of all queries and emit
      // the socket error on the client as well
      _handleErrorEvent(err) {
        if (this._connecting) {
          return this._handleErrorWhileConnecting(err);
        }
        this._queryable = false;
        this._errorAllQueries(err);
        this.emit("error", err);
      }
      // handle error messages from the postgres backend
      _handleErrorMessage(msg) {
        if (this._connecting) {
          return this._handleErrorWhileConnecting(msg);
        }
        const activeQuery = this._getActiveQuery();
        if (!activeQuery) {
          this._handleErrorEvent(msg);
          return;
        }
        this._activeQuery = null;
        if (activeQuery.name) {
          delete this.connection.submittedNamedStatements[activeQuery.name];
        }
        activeQuery.handleError(msg, this.connection);
      }
      _handleRowDescription(msg) {
        const activeQuery = this._getActiveQuery();
        if (activeQuery == null) {
          const error = new Error("Received unexpected rowDescription message from backend.");
          this._handleErrorEvent(error);
          return;
        }
        activeQuery.handleRowDescription(msg);
      }
      _handleDataRow(msg) {
        const activeQuery = this._getActiveQuery();
        if (activeQuery == null) {
          const error = new Error("Received unexpected dataRow message from backend.");
          this._handleErrorEvent(error);
          return;
        }
        activeQuery.handleDataRow(msg);
      }
      _handlePortalSuspended(msg) {
        const activeQuery = this._getActiveQuery();
        if (activeQuery == null) {
          const error = new Error("Received unexpected portalSuspended message from backend.");
          this._handleErrorEvent(error);
          return;
        }
        activeQuery.handlePortalSuspended(this.connection);
      }
      _handleEmptyQuery(msg) {
        const activeQuery = this._getActiveQuery();
        if (activeQuery == null) {
          const error = new Error("Received unexpected emptyQuery message from backend.");
          this._handleErrorEvent(error);
          return;
        }
        activeQuery.handleEmptyQuery(this.connection);
      }
      _handleCommandComplete(msg) {
        const activeQuery = this._getActiveQuery();
        if (activeQuery == null) {
          const error = new Error("Received unexpected commandComplete message from backend.");
          this._handleErrorEvent(error);
          return;
        }
        activeQuery.handleCommandComplete(msg, this.connection);
      }
      _handleParseComplete() {
        const activeQuery = this._getActiveQuery();
        if (activeQuery == null) {
          const error = new Error("Received unexpected parseComplete message from backend.");
          this._handleErrorEvent(error);
          return;
        }
        if (activeQuery.name) {
          this.connection.parsedStatements[activeQuery.name] = activeQuery.text;
          delete this.connection.submittedNamedStatements[activeQuery.name];
        }
      }
      _handleCopyInResponse(msg) {
        const activeQuery = this._getActiveQuery();
        if (activeQuery == null) {
          const error = new Error("Received unexpected copyInResponse message from backend.");
          this._handleErrorEvent(error);
          return;
        }
        activeQuery.handleCopyInResponse(this.connection);
      }
      _handleCopyData(msg) {
        const activeQuery = this._getActiveQuery();
        if (activeQuery == null) {
          const error = new Error("Received unexpected copyData message from backend.");
          this._handleErrorEvent(error);
          return;
        }
        activeQuery.handleCopyData(msg, this.connection);
      }
      _handleNotification(msg) {
        this.emit("notification", msg);
      }
      _handleNotice(msg) {
        this.emit("notice", msg);
      }
      getStartupConf() {
        const params = this.connectionParameters;
        const data = {
          user: params.user,
          database: params.database
        };
        const appName = params.application_name || params.fallback_application_name;
        if (appName) {
          data.application_name = appName;
        }
        if (params.replication) {
          data.replication = "" + params.replication;
        }
        if (params.statement_timeout) {
          data.statement_timeout = String(parseInt(params.statement_timeout, 10));
        }
        if (params.lock_timeout) {
          data.lock_timeout = String(parseInt(params.lock_timeout, 10));
        }
        if (params.idle_in_transaction_session_timeout) {
          data.idle_in_transaction_session_timeout = String(parseInt(params.idle_in_transaction_session_timeout, 10));
        }
        if (params.options) {
          data.options = params.options;
        }
        return data;
      }
      cancel(client, query) {
        if (client.activeQuery === query) {
          const con = this.connection;
          if (this.host && this.host.indexOf("/") === 0) {
            con.connect(this.host + "/.s.PGSQL." + this.port);
          } else {
            con.connect(this.port, this.host);
          }
          con.on("connect", function() {
            con.cancel(client.processID, client.secretKey);
          });
        } else if (client._queryQueue.indexOf(query) !== -1) {
          client._queryQueue.splice(client._queryQueue.indexOf(query), 1);
        } else if (client._sentQueryQueue.indexOf(query) !== -1) {
          query.callback = () => {
          };
        }
      }
      setTypeParser(oid, format, parseFn) {
        return this._types.setTypeParser(oid, format, parseFn);
      }
      getTypeParser(oid, format) {
        return this._types.getTypeParser(oid, format);
      }
      // escapeIdentifier and escapeLiteral moved to utility functions & exported
      // on PG
      // re-exported here for backwards compatibility
      escapeIdentifier(str) {
        return utils.escapeIdentifier(str);
      }
      escapeLiteral(str) {
        return utils.escapeLiteral(str);
      }
      _pulseQueryQueue() {
        if (this.pipeline) {
          this._pulsePipelinedQueryQueue();
          return;
        }
        if (this.readyForQuery === true) {
          this._activeQuery = this._queryQueue.shift();
          const activeQuery = this._getActiveQuery();
          if (activeQuery) {
            this.readyForQuery = false;
            this.hasExecuted = true;
            const queryError = activeQuery.submit(this.connection);
            if (queryError) {
              process.nextTick(() => {
                activeQuery.handleError(queryError, this.connection);
                this.readyForQuery = true;
                this._pulseQueryQueue();
              });
            }
          } else if (this.hasExecuted) {
            this._activeQuery = null;
            this.emit("drain");
          }
        }
      }
      _pulsePipelinedQueryQueue() {
        if (!this._connected || !this._queryable) {
          return;
        }
        while (this._queryQueue.length > 0) {
          const query = this._queryQueue.shift();
          this.hasExecuted = true;
          const queryError = query.submit(this.connection);
          if (queryError) {
            process.nextTick(() => {
              query.handleError(queryError, this.connection);
            });
            continue;
          }
          this._sentQueryQueue.push(query);
        }
        if (this.readyForQuery && !this._activeQuery && this._sentQueryQueue.length > 0) {
          this._activeQuery = this._sentQueryQueue.shift();
          this.readyForQuery = false;
        }
        if (!this._activeQuery && this._sentQueryQueue.length === 0 && this._queryQueue.length === 0 && this.hasExecuted) {
          this.emit("drain");
        }
      }
      query(config2, values, callback) {
        let query;
        let result;
        if (config2 == null) {
          throw new TypeError("Client was passed a null or undefined query");
        }
        if (typeof config2.submit === "function") {
          result = query = config2;
          if (!query.callback) {
            if (typeof values === "function") {
              query.callback = values;
            } else if (callback) {
              query.callback = callback;
            }
          }
        } else {
          query = new Query2(config2, values, callback);
          if (!query.callback) {
            result = new this._Promise((resolve, reject) => {
              query.callback = (err, res) => err ? reject(err) : resolve(res);
            }).catch((err) => {
              Error.captureStackTrace(err);
              throw err;
            });
          } else if (typeof query.callback !== "function") {
            throw new TypeError("callback is not a function");
          }
        }
        const readTimeout = config2.query_timeout || this.connectionParameters.query_timeout;
        if (readTimeout) {
          const queryCallback = query.callback || (() => {
          });
          const readTimeoutTimer = setTimeout(() => {
            const error = new Error("Query read timeout");
            process.nextTick(() => {
              query.handleError(error, this.connection);
            });
            queryCallback(error);
            query.callback = () => {
            };
            const index = this._queryQueue.indexOf(query);
            if (index > -1) {
              this._queryQueue.splice(index, 1);
            } else if (this.pipeline) {
              this.connection.stream.destroy();
              return;
            }
            this._pulseQueryQueue();
          }, readTimeout);
          query.callback = (err, res) => {
            clearTimeout(readTimeoutTimer);
            queryCallback(err, res);
          };
        }
        if (this.binary && !query.binary) {
          query.binary = true;
        }
        if (query._result && !query._result._types) {
          query._result._types = this._types;
        }
        if (this.pipeline) {
          const portalQuery = typeof config2.submit === "function" && !(query instanceof Query2) ? "Custom query classes such as pg-cursor and pg-query-stream are" : query.rows ? "The `rows` option is" : null;
          if (portalQuery) {
            process.nextTick(() => {
              query.handleError(new Error(`${portalQuery} not supported in pipeline mode`), this.connection);
            });
            return result;
          }
        }
        if (!this._queryable) {
          process.nextTick(() => {
            query.handleError(new Error("Client has encountered a connection error and is not queryable"), this.connection);
          });
          return result;
        }
        if (this._ending) {
          process.nextTick(() => {
            query.handleError(new Error("Client was closed and is not queryable"), this.connection);
          });
          return result;
        }
        if (this._queryQueue.length > 0 && !this.pipeline) {
          queryQueueLengthDeprecationNotice();
        }
        this._queryQueue.push(query);
        this._pulseQueryQueue();
        return result;
      }
      ref() {
        this.connection.ref();
      }
      unref() {
        this.connection.unref();
      }
      getTransactionStatus() {
        return this._txStatus;
      }
      end(cb) {
        this._ending = true;
        if (!this.connection._connecting || this._ended) {
          if (cb) {
            cb();
            return;
          } else {
            return this._Promise.resolve();
          }
        }
        if (!this._queryable) {
          this.connection.stream.destroy();
        } else if (this.pipeline && (this._getActiveQuery() || this._sentQueryQueue.length > 0 || this._queryQueue.length > 0)) {
          this.once("drain", () => this.connection.end());
        } else if (this._getActiveQuery()) {
          this.connection.stream.destroy();
        } else {
          this.connection.end();
        }
        if (cb) {
          this.connection.once("end", cb);
        } else {
          return new this._Promise((resolve) => {
            this.connection.once("end", resolve);
          });
        }
      }
      get queryQueue() {
        queryQueueDeprecationNotice();
        return this._queryQueue;
      }
    };
    Client2.Query = Query2;
    module.exports = Client2;
  }
});

// scheduler/node_modules/pg-pool/index.js
var require_pg_pool = __commonJS({
  "scheduler/node_modules/pg-pool/index.js"(exports, module) {
    "use strict";
    var EventEmitter = __require("events").EventEmitter;
    var NOOP = function() {
    };
    var removeWhere = (list, predicate) => {
      const i = list.findIndex(predicate);
      return i === -1 ? void 0 : list.splice(i, 1)[0];
    };
    var IdleItem = class {
      constructor(client, idleListener, timeoutId) {
        this.client = client;
        this.idleListener = idleListener;
        this.timeoutId = timeoutId;
      }
    };
    var PendingItem = class {
      constructor(callback) {
        this.callback = callback;
      }
    };
    function throwOnDoubleRelease() {
      throw new Error("Release called on client which has already been released to the pool.");
    }
    function promisify(Promise2, callback) {
      if (callback) {
        return { callback, result: void 0 };
      }
      let rej;
      let res;
      const cb = function(err, client) {
        err ? rej(err) : res(client);
      };
      const result = new Promise2(function(resolve, reject) {
        res = resolve;
        rej = reject;
      }).catch((err) => {
        Error.captureStackTrace(err);
        throw err;
      });
      return { callback: cb, result };
    }
    function makeIdleListener(pool2, client) {
      return function idleListener(err) {
        err.client = client;
        client.removeListener("error", idleListener);
        client.on("error", () => {
          pool2.log("additional client error after disconnection due to error", err);
        });
        pool2._remove(client);
        pool2.emit("error", err, client);
      };
    }
    var Pool3 = class extends EventEmitter {
      constructor(options, Client2) {
        super();
        this.options = Object.assign({}, options);
        if (options != null && "password" in options) {
          Object.defineProperty(this.options, "password", {
            configurable: true,
            enumerable: false,
            writable: true,
            value: options.password
          });
        }
        if (options != null && options.ssl && options.ssl.key) {
          Object.defineProperty(this.options.ssl, "key", {
            enumerable: false
          });
        }
        this.options.max = this.options.max || this.options.poolSize || 10;
        this.options.min = this.options.min || 0;
        this.options.maxUses = this.options.maxUses || Infinity;
        this.options.allowExitOnIdle = this.options.allowExitOnIdle || false;
        this.options.maxLifetimeSeconds = this.options.maxLifetimeSeconds || 0;
        this.log = this.options.log || function() {
        };
        this.Client = this.options.Client || Client2 || require_lib2().Client;
        this.Promise = this.options.Promise || global.Promise;
        if (typeof this.options.idleTimeoutMillis === "undefined") {
          this.options.idleTimeoutMillis = 1e4;
        }
        this._clients = [];
        this._idle = [];
        this._expired = /* @__PURE__ */ new WeakSet();
        this._pendingQueue = [];
        this._endCallback = void 0;
        this.ending = false;
        this.ended = false;
      }
      _promiseTry(f) {
        const Promise2 = this.Promise;
        if (typeof Promise2.try === "function") {
          return Promise2.try(f);
        }
        return new Promise2((resolve) => resolve(f()));
      }
      _isFull() {
        return this._clients.length >= this.options.max;
      }
      _isAboveMin() {
        return this._clients.length > this.options.min;
      }
      _pulseQueue() {
        this.log("pulse queue");
        if (this.ended) {
          this.log("pulse queue ended");
          return;
        }
        if (this.ending) {
          this.log("pulse queue on ending");
          if (this._idle.length) {
            this._idle.slice().map((item) => {
              this._remove(item.client);
            });
          }
          if (!this._clients.length) {
            this.ended = true;
            this._endCallback();
          }
          return;
        }
        if (!this._pendingQueue.length) {
          this.log("no queued requests");
          return;
        }
        if (!this._idle.length && this._isFull()) {
          return;
        }
        const pendingItem = this._pendingQueue.shift();
        if (this._idle.length) {
          const idleItem = this._idle.pop();
          clearTimeout(idleItem.timeoutId);
          const client = idleItem.client;
          client.ref && client.ref();
          const idleListener = idleItem.idleListener;
          return this._acquireClient(client, pendingItem, idleListener, false);
        }
        if (!this._isFull()) {
          return this.newClient(pendingItem);
        }
        throw new Error("unexpected condition");
      }
      _remove(client, callback) {
        const removed = removeWhere(this._idle, (item) => item.client === client);
        if (removed !== void 0) {
          clearTimeout(removed.timeoutId);
        }
        this._clients = this._clients.filter((c) => c !== client);
        const context = this;
        client.end(() => {
          context.emit("remove", client);
          if (typeof callback === "function") {
            callback();
          }
        });
      }
      connect(cb) {
        if (this.ending) {
          const err = new Error("Cannot use a pool after calling end on the pool");
          return cb ? cb(err) : this.Promise.reject(err);
        }
        const response = promisify(this.Promise, cb);
        const result = response.result;
        if (this._isFull() || this._idle.length) {
          if (this._idle.length) {
            process.nextTick(() => this._pulseQueue());
          }
          if (!this.options.connectionTimeoutMillis) {
            this._pendingQueue.push(new PendingItem(response.callback));
            return result;
          }
          const queueCallback = (err, res, done) => {
            clearTimeout(tid);
            response.callback(err, res, done);
          };
          const pendingItem = new PendingItem(queueCallback);
          const tid = setTimeout(() => {
            removeWhere(this._pendingQueue, (i) => i.callback === queueCallback);
            pendingItem.timedOut = true;
            response.callback(new Error("timeout exceeded when trying to connect"));
          }, this.options.connectionTimeoutMillis);
          if (tid.unref) {
            tid.unref();
          }
          this._pendingQueue.push(pendingItem);
          return result;
        }
        this.newClient(new PendingItem(response.callback));
        return result;
      }
      newClient(pendingItem) {
        const client = new this.Client(this.options);
        this._clients.push(client);
        const idleListener = makeIdleListener(this, client);
        this.log("checking client timeout");
        let tid;
        let timeoutHit = false;
        if (this.options.connectionTimeoutMillis) {
          tid = setTimeout(() => {
            if (client.connection) {
              this.log("ending client due to timeout");
              timeoutHit = true;
              client.connection.stream.destroy();
            } else if (!client.isConnected()) {
              this.log("ending client due to timeout");
              timeoutHit = true;
              client.end();
            }
          }, this.options.connectionTimeoutMillis);
        }
        this.log("connecting new client");
        client.connect((err) => {
          if (tid) {
            clearTimeout(tid);
          }
          client.on("error", idleListener);
          if (err) {
            this.log("client failed to connect", err);
            this._clients = this._clients.filter((c) => c !== client);
            if (timeoutHit) {
              err = new Error("Connection terminated due to connection timeout", { cause: err });
            }
            this._pulseQueue();
            if (!pendingItem.timedOut) {
              pendingItem.callback(err, void 0, NOOP);
            }
          } else {
            this.log("new client connected");
            if (this.options.onConnect) {
              this._promiseTry(() => this.options.onConnect(client)).then(
                () => {
                  this._afterConnect(client, pendingItem, idleListener);
                },
                (hookErr) => {
                  this._clients = this._clients.filter((c) => c !== client);
                  client.end(() => {
                    this._pulseQueue();
                    if (!pendingItem.timedOut) {
                      pendingItem.callback(hookErr, void 0, NOOP);
                    }
                  });
                }
              );
              return;
            }
            return this._afterConnect(client, pendingItem, idleListener);
          }
        });
      }
      _afterConnect(client, pendingItem, idleListener) {
        if (this.options.maxLifetimeSeconds !== 0) {
          const maxLifetimeTimeout = setTimeout(() => {
            this.log("ending client due to expired lifetime");
            this._expired.add(client);
            const idleIndex = this._idle.findIndex((idleItem) => idleItem.client === client);
            if (idleIndex !== -1) {
              this._acquireClient(
                client,
                new PendingItem((err, client2, clientRelease) => clientRelease()),
                idleListener,
                false
              );
            }
          }, this.options.maxLifetimeSeconds * 1e3);
          maxLifetimeTimeout.unref();
          client.once("end", () => clearTimeout(maxLifetimeTimeout));
        }
        return this._acquireClient(client, pendingItem, idleListener, true);
      }
      // acquire a client for a pending work item
      _acquireClient(client, pendingItem, idleListener, isNew) {
        if (isNew) {
          this.emit("connect", client);
        }
        this.emit("acquire", client);
        client.release = this._releaseOnce(client, idleListener);
        client.removeListener("error", idleListener);
        if (!pendingItem.timedOut) {
          if (isNew && this.options.verify) {
            this.options.verify(client, (err) => {
              if (err) {
                client.release(err);
                return pendingItem.callback(err, void 0, NOOP);
              }
              pendingItem.callback(void 0, client, client.release);
            });
          } else {
            pendingItem.callback(void 0, client, client.release);
          }
        } else {
          if (isNew && this.options.verify) {
            this.options.verify(client, client.release);
          } else {
            client.release();
          }
        }
      }
      // returns a function that wraps _release and throws if called more than once
      _releaseOnce(client, idleListener) {
        let released = false;
        return (err) => {
          if (released) {
            throwOnDoubleRelease();
          }
          released = true;
          this._release(client, idleListener, err);
        };
      }
      // release a client back to the poll, include an error
      // to remove it from the pool
      _release(client, idleListener, err) {
        client.on("error", idleListener);
        client._poolUseCount = (client._poolUseCount || 0) + 1;
        this.emit("release", err, client);
        if (err || this.ending || !client._queryable || client._ending || client._poolUseCount >= this.options.maxUses) {
          if (client._poolUseCount >= this.options.maxUses) {
            this.log("remove expended client");
          }
          return this._remove(client, this._pulseQueue.bind(this));
        }
        const isExpired = this._expired.has(client);
        if (isExpired) {
          this.log("remove expired client");
          this._expired.delete(client);
          return this._remove(client, this._pulseQueue.bind(this));
        }
        let tid;
        if (this.options.idleTimeoutMillis && this._isAboveMin()) {
          tid = setTimeout(() => {
            if (this._isAboveMin()) {
              this.log("remove idle client");
              this._remove(client, this._pulseQueue.bind(this));
            }
          }, this.options.idleTimeoutMillis);
          if (this.options.allowExitOnIdle) {
            tid.unref();
          }
        }
        if (this.options.allowExitOnIdle) {
          client.unref();
        }
        this._idle.push(new IdleItem(client, idleListener, tid));
        this._pulseQueue();
      }
      query(text, values, cb) {
        if (typeof text === "function") {
          const response2 = promisify(this.Promise, text);
          setImmediate(function() {
            return response2.callback(new Error("Passing a function as the first parameter to pool.query is not supported"));
          });
          return response2.result;
        }
        if (typeof values === "function") {
          cb = values;
          values = void 0;
        }
        const response = promisify(this.Promise, cb);
        cb = response.callback;
        this.connect((err, client) => {
          if (err) {
            return cb(err);
          }
          let clientReleased = false;
          const onError = (err2) => {
            if (clientReleased) {
              return;
            }
            clientReleased = true;
            client.release(err2);
            cb(err2);
          };
          client.once("error", onError);
          this.log("dispatching query");
          try {
            client.query(text, values, (err2, res) => {
              this.log("query dispatched");
              client.removeListener("error", onError);
              if (clientReleased) {
                return;
              }
              clientReleased = true;
              client.release(err2);
              if (err2) {
                return cb(err2);
              }
              return cb(void 0, res);
            });
          } catch (err2) {
            client.release(err2);
            return cb(err2);
          }
        });
        return response.result;
      }
      end(cb) {
        this.log("ending");
        if (this.ending) {
          const err = new Error("Called end on pool more than once");
          return cb ? cb(err) : this.Promise.reject(err);
        }
        this.ending = true;
        const promised = promisify(this.Promise, cb);
        this._endCallback = promised.callback;
        this._pulseQueue();
        return promised.result;
      }
      get waitingCount() {
        return this._pendingQueue.length;
      }
      get idleCount() {
        return this._idle.length;
      }
      get expiredCount() {
        return this._clients.reduce((acc, client) => acc + (this._expired.has(client) ? 1 : 0), 0);
      }
      get totalCount() {
        return this._clients.length;
      }
    };
    module.exports = Pool3;
  }
});

// scheduler/node_modules/pg/lib/native/query.js
var require_query2 = __commonJS({
  "scheduler/node_modules/pg/lib/native/query.js"(exports, module) {
    "use strict";
    var EventEmitter = __require("events").EventEmitter;
    var util = __require("util");
    var utils = require_utils();
    var NativeQuery = module.exports = function(config2, values, callback) {
      EventEmitter.call(this);
      config2 = utils.normalizeQueryConfig(config2, values, callback);
      this.text = config2.text;
      this.values = config2.values;
      this.name = config2.name;
      this.queryMode = config2.queryMode;
      this.callback = config2.callback;
      this.state = "new";
      this._arrayMode = config2.rowMode === "array";
      this._emitRowEvents = false;
      this.on(
        "newListener",
        function(event) {
          if (event === "row") this._emitRowEvents = true;
        }.bind(this)
      );
    };
    util.inherits(NativeQuery, EventEmitter);
    var errorFieldMap = {
      sqlState: "code",
      statementPosition: "position",
      messagePrimary: "message",
      messageDetail: "detail",
      messageHint: "hint",
      context: "where",
      schemaName: "schema",
      tableName: "table",
      columnName: "column",
      dataTypeName: "dataType",
      constraintName: "constraint",
      sourceFile: "file",
      sourceLine: "line",
      sourceFunction: "routine"
    };
    NativeQuery.prototype.handleError = function(err) {
      const fields = this.native && this.native.pq.resultErrorFields();
      if (fields) {
        for (const key in fields) {
          const normalizedFieldName = errorFieldMap[key] || key;
          err[normalizedFieldName] = fields[key];
        }
      }
      if (this.callback) {
        this.callback(err);
      } else {
        this.emit("error", err);
      }
      this.state = "error";
    };
    NativeQuery.prototype.then = function(onSuccess, onFailure) {
      return this._getPromise().then(onSuccess, onFailure);
    };
    NativeQuery.prototype.catch = function(callback) {
      return this._getPromise().catch(callback);
    };
    NativeQuery.prototype._getPromise = function() {
      if (this._promise) return this._promise;
      this._promise = new Promise(
        function(resolve, reject) {
          this._once("end", resolve);
          this._once("error", reject);
        }.bind(this)
      );
      return this._promise;
    };
    NativeQuery.prototype.submit = function(client) {
      this.state = "running";
      const self = this;
      this.native = client.native;
      client.native.arrayMode = this._arrayMode;
      let after = function(err, rows, results) {
        client.native.arrayMode = false;
        setImmediate(function() {
          self.emit("_done");
        });
        if (err) {
          return self.handleError(err);
        }
        if (self._emitRowEvents) {
          if (results.length > 1) {
            rows.forEach((rowOfRows, i) => {
              rowOfRows.forEach((row) => {
                self.emit("row", row, results[i]);
              });
            });
          } else {
            rows.forEach(function(row) {
              self.emit("row", row, results);
            });
          }
        }
        self.state = "end";
        self.emit("end", results);
        if (self.callback) {
          self.callback(null, results);
        }
      };
      if (process.domain) {
        after = process.domain.bind(after);
      }
      if (this.name) {
        if (this.name.length > 63) {
          console.error("Warning! Postgres only supports 63 characters for query names.");
          console.error("You supplied %s (%s)", this.name, this.name.length);
          console.error("This can cause conflicts and silent errors executing queries");
        }
        const values = (this.values || []).map(utils.prepareValue);
        if (client.namedQueries[this.name] !== void 0) {
          if (this.text && client.namedQueries[this.name] !== this.text) {
            const err = new Error(`Prepared statements must be unique - '${this.name}' was used for a different statement`);
            return after(err);
          }
          return client.native.execute(this.name, values, after);
        }
        return client.native.prepare(this.name, this.text, values.length, function(err) {
          if (err) return after(err);
          client.namedQueries[self.name] = self.text;
          return self.native.execute(self.name, values, after);
        });
      } else if (this.values) {
        if (!Array.isArray(this.values)) {
          const err = new Error("Query values must be an array");
          return after(err);
        }
        const vals = this.values.map(utils.prepareValue);
        client.native.query(this.text, vals, after);
      } else if (this.queryMode === "extended") {
        client.native.query(this.text, [], after);
      } else {
        client.native.query(this.text, after);
      }
    };
  }
});

// scheduler/node_modules/pg/lib/native/client.js
var require_client2 = __commonJS({
  "scheduler/node_modules/pg/lib/native/client.js"(exports, module) {
    var nodeUtils = __require("util");
    var Native;
    try {
      Native = __require("pg-native");
    } catch (e) {
      throw e;
    }
    var TypeOverrides2 = require_type_overrides();
    var EventEmitter = __require("events").EventEmitter;
    var util = __require("util");
    var ConnectionParameters = require_connection_parameters();
    var NativeQuery = require_query2();
    var queryQueueLengthDeprecationNotice = nodeUtils.deprecate(
      () => {
      },
      "Calling client.query() when the client is already executing a query is deprecated and will be removed in pg@9.0. Use async/await or an external async flow control mechanism instead."
    );
    var Client2 = module.exports = function(config2) {
      EventEmitter.call(this);
      config2 = config2 || {};
      this._Promise = config2.Promise || global.Promise;
      this._types = new TypeOverrides2(config2.types);
      this.native = new Native({
        types: this._types
      });
      this._queryQueue = [];
      this._ending = false;
      this._connecting = false;
      this._connected = false;
      this._queryable = true;
      this.pipeline = Boolean(config2.pipeline);
      this._pipelineInFlight = false;
      const cp = this.connectionParameters = new ConnectionParameters(config2);
      if (config2.nativeConnectionString) cp.nativeConnectionString = config2.nativeConnectionString;
      this.user = cp.user;
      Object.defineProperty(this, "password", {
        configurable: true,
        enumerable: false,
        writable: true,
        value: cp.password
      });
      this.database = cp.database;
      this.host = cp.host;
      this.port = cp.port;
      this.namedQueries = {};
    };
    Client2.Query = NativeQuery;
    util.inherits(Client2, EventEmitter);
    Client2.prototype._errorAllQueries = function(err) {
      const enqueueError = (query) => {
        process.nextTick(() => {
          query.native = this.native;
          query.handleError(err);
        });
      };
      if (this._hasActiveQuery()) {
        enqueueError(this._activeQuery);
        this._activeQuery = null;
      }
      this._queryQueue.forEach(enqueueError);
      this._queryQueue.length = 0;
    };
    Client2.prototype._connect = function(cb) {
      const self = this;
      if (this._connecting) {
        process.nextTick(() => cb(new Error("Client has already been connected. You cannot reuse a client.")));
        return;
      }
      this._connecting = true;
      this.connectionParameters.getLibpqConnectionString(function(err, conString) {
        if (self.connectionParameters.nativeConnectionString) conString = self.connectionParameters.nativeConnectionString;
        if (err) return cb(err);
        self.native.connect(conString, function(err2) {
          if (err2) {
            self.native.end();
            return cb(err2);
          }
          self._connected = true;
          self.native.on("error", function(err3) {
            self._queryable = false;
            self._errorAllQueries(err3);
            self.emit("error", err3);
          });
          self.native.on("notification", function(msg) {
            self.emit("notification", {
              channel: msg.relname,
              payload: msg.extra
            });
          });
          self.emit("connect");
          self._pulseQueryQueue(true);
          cb(null, this);
        });
      });
    };
    Client2.prototype.connect = function(callback) {
      if (callback) {
        this._connect(callback);
        return;
      }
      return new this._Promise((resolve, reject) => {
        this._connect((error) => {
          if (error) {
            reject(error);
          } else {
            resolve(this);
          }
        });
      });
    };
    Client2.prototype.query = function(config2, values, callback) {
      let query;
      let result;
      let readTimeout;
      let readTimeoutTimer;
      let queryCallback;
      if (config2 === null || config2 === void 0) {
        throw new TypeError("Client was passed a null or undefined query");
      } else if (typeof config2.submit === "function") {
        readTimeout = config2.query_timeout || this.connectionParameters.query_timeout;
        result = query = config2;
        if (typeof values === "function") {
          config2.callback = values;
        }
      } else {
        readTimeout = config2.query_timeout || this.connectionParameters.query_timeout;
        query = new NativeQuery(config2, values, callback);
        if (!query.callback) {
          let resolveOut, rejectOut;
          result = new this._Promise((resolve, reject) => {
            resolveOut = resolve;
            rejectOut = reject;
          }).catch((err) => {
            Error.captureStackTrace(err);
            throw err;
          });
          query.callback = (err, res) => err ? rejectOut(err) : resolveOut(res);
        }
      }
      if (readTimeout) {
        queryCallback = query.callback || (() => {
        });
        readTimeoutTimer = setTimeout(() => {
          const error = new Error("Query read timeout");
          process.nextTick(() => {
            query.handleError(error, this.connection);
          });
          queryCallback(error);
          query.callback = () => {
          };
          const index = this._queryQueue.indexOf(query);
          if (index > -1) {
            this._queryQueue.splice(index, 1);
          }
          this._pulseQueryQueue();
        }, readTimeout);
        query.callback = (err, res) => {
          clearTimeout(readTimeoutTimer);
          queryCallback(err, res);
        };
      }
      if (!this._queryable) {
        query.native = this.native;
        process.nextTick(() => {
          query.handleError(new Error("Client has encountered a connection error and is not queryable"));
        });
        return result;
      }
      if (this._ending) {
        query.native = this.native;
        process.nextTick(() => {
          query.handleError(new Error("Client was closed and is not queryable"));
        });
        return result;
      }
      if (this._queryQueue.length > 0 && !this.pipeline) {
        queryQueueLengthDeprecationNotice();
      }
      this._queryQueue.push(query);
      this._pulseQueryQueue();
      return result;
    };
    Client2.prototype.end = function(cb) {
      const self = this;
      this._ending = true;
      if (this._connecting && !this._connected) {
        this.once("connect", () => {
          this.end(() => {
          });
        });
      }
      let result;
      if (!cb) {
        result = new this._Promise(function(resolve, reject) {
          cb = (err) => err ? reject(err) : resolve();
        });
      }
      const doEnd = function() {
        self.native.end(function() {
          self._connected = false;
          self._errorAllQueries(new Error("Connection terminated"));
          process.nextTick(() => {
            self.emit("end");
            if (cb) cb();
          });
        });
      };
      if (this.pipeline && (this._pipelineInFlight || this._queryQueue.length > 0)) {
        this.once("drain", doEnd);
      } else {
        doEnd();
      }
      return result;
    };
    Client2.prototype._hasActiveQuery = function() {
      return this._activeQuery && this._activeQuery.state !== "error" && this._activeQuery.state !== "end";
    };
    Client2.prototype._pulseQueryQueue = function(initialConnection) {
      if (!this._connected) {
        return;
      }
      if (this.pipeline && !initialConnection) {
        return this._pulsePipelinedQueryQueue();
      }
      if (this._hasActiveQuery()) {
        return;
      }
      const query = this._queryQueue.shift();
      if (!query) {
        if (!initialConnection) {
          this.emit("drain");
        }
        return;
      }
      this._activeQuery = query;
      query.submit(this);
      const self = this;
      query.once("_done", function() {
        self._pulseQueryQueue();
      });
    };
    Client2.prototype._pulsePipelinedQueryQueue = function() {
      if (!this._connected || this._pipelineInFlight) {
        return;
      }
      if (this._queryQueue.length === 0) {
        if (this.hasExecuted) {
          this.emit("drain");
        }
        return;
      }
      this._pipelineInFlight = true;
      const self = this;
      const queries = [];
      const nativeQueries = [];
      const utils = require_utils();
      while (this._queryQueue.length > 0) {
        const query = this._queryQueue.shift();
        this.hasExecuted = true;
        nativeQueries.push(query);
        const values = query.values ? query.values.map(utils.prepareValue) : null;
        const pipelineEntry = { text: query.text, name: query.name, arrayMode: query._arrayMode };
        if (values) {
          pipelineEntry.values = values;
        }
        if (query.name && this.namedQueries[query.name]) {
          pipelineEntry._alreadyPrepared = true;
        }
        queries.push(pipelineEntry);
      }
      this.native.pipeline(queries, function(err, results) {
        self._pipelineInFlight = false;
        if (err) {
          self._connected = false;
          self._queryable = false;
          for (let i = 0; i < nativeQueries.length; i++) {
            const q2 = nativeQueries[i];
            q2.native = self.native;
            q2.handleError(err);
          }
          self._errorAllQueries(err);
          self.emit("error", err);
          self.emit("end");
          return;
        }
        for (let i = 0; i < nativeQueries.length; i++) {
          const q2 = nativeQueries[i];
          const r = results[i];
          q2.native = self.native;
          if (r.err) {
            q2.handleError(r.err);
          } else {
            if (q2.name) {
              self.namedQueries[q2.name] = q2.text;
            }
            q2.state = "end";
            q2.emit("end", r.result);
            if (q2.callback) {
              q2.callback(null, r.result);
            }
          }
          setImmediate(function() {
            q2.emit("_done");
          });
        }
        self._pulsePipelinedQueryQueue();
      });
    };
    Client2.prototype.cancel = function(query) {
      if (this._activeQuery === query) {
        this.native.cancel(function() {
        });
      } else if (this._queryQueue.indexOf(query) !== -1) {
        this._queryQueue.splice(this._queryQueue.indexOf(query), 1);
      }
    };
    Client2.prototype.ref = function() {
    };
    Client2.prototype.unref = function() {
    };
    Client2.prototype.setTypeParser = function(oid, format, parseFn) {
      return this._types.setTypeParser(oid, format, parseFn);
    };
    Client2.prototype.getTypeParser = function(oid, format) {
      return this._types.getTypeParser(oid, format);
    };
    Client2.prototype.isConnected = function() {
      return this._connected;
    };
    Client2.prototype.getTransactionStatus = function() {
      return this.native.getTransactionStatus();
    };
  }
});

// scheduler/node_modules/pg/lib/native/index.js
var require_native = __commonJS({
  "scheduler/node_modules/pg/lib/native/index.js"(exports, module) {
    "use strict";
    module.exports = require_client2();
  }
});

// scheduler/node_modules/pg/lib/index.js
var require_lib2 = __commonJS({
  "scheduler/node_modules/pg/lib/index.js"(exports, module) {
    "use strict";
    var Client2 = require_client();
    var defaults2 = require_defaults();
    var Connection2 = require_connection();
    var Result2 = require_result();
    var utils = require_utils();
    var Pool3 = require_pg_pool();
    var TypeOverrides2 = require_type_overrides();
    var { DatabaseError: DatabaseError2 } = require_dist();
    var { escapeIdentifier: escapeIdentifier2, escapeLiteral: escapeLiteral2 } = require_utils();
    var poolFactory = (Client3) => {
      return class BoundPool extends Pool3 {
        constructor(options) {
          super(options, Client3);
        }
      };
    };
    var PG = function(clientConstructor2) {
      this.defaults = defaults2;
      this.Client = clientConstructor2;
      this.Query = this.Client.Query;
      this.Pool = poolFactory(this.Client);
      this._pools = [];
      this.Connection = Connection2;
      this.types = require_pg_types();
      this.DatabaseError = DatabaseError2;
      this.TypeOverrides = TypeOverrides2;
      this.escapeIdentifier = escapeIdentifier2;
      this.escapeLiteral = escapeLiteral2;
      this.Result = Result2;
      this.utils = utils;
    };
    var clientConstructor = Client2;
    var forceNative = false;
    try {
      forceNative = !!process.env.NODE_PG_FORCE_NATIVE;
    } catch {
    }
    if (forceNative) {
      clientConstructor = require_native();
    }
    module.exports = new PG(clientConstructor);
    Object.defineProperty(module.exports, "native", {
      configurable: true,
      enumerable: false,
      get() {
        let native = null;
        try {
          native = new PG(require_native());
        } catch (err) {
          if (err.code !== "MODULE_NOT_FOUND") {
            throw err;
          }
        }
        Object.defineProperty(module.exports, "native", {
          value: native
        });
        return native;
      }
    });
  }
});

// scheduler/src/core/resources.ts
var MIB = 1024 ** 2;
var DEFAULT_DYNAMIC_POLICY = {
  max_instances_per_host: 64,
  cpu_single_overcommit: 4,
  overcommit_warn: 2,
  h_min: 0.05,
  w_floor: 25,
  w_degrade_scope: "resource",
  pressure_enter: { busy: 0.7, pressure: 0.85, critical: 0.95 },
  pressure_exit: { busy: 0.6, pressure: 0.75, critical: 0.9 },
  recovery_hold_seconds: 60,
  grant_update_interval_seconds: 5,
  reclaim_cooldown_seconds: 3,
  reclaim_check_window_seconds: 5,
  reclaim_max_steps: 3,
  require_applied_before_start: true,
  idle_floor_cpu_millicores: 50,
  idle_floor_mem_bytes: 128 * MIB,
  ewma_alpha: 0.3,
  dispatch_window_seconds: 15
};
var num = (value, fallback) => {
  const n2 = Number(value);
  return Number.isFinite(n2) ? n2 : fallback;
};
var ratio = (value, fallback) => {
  const n2 = num(value, fallback);
  return Math.max(0, Math.min(1, n2));
};
function normalizeDynamicPolicy(input) {
  const raw = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const enter = raw.pressure_enter ?? {};
  const exit = raw.pressure_exit ?? {};
  return {
    max_instances_per_host: Math.max(1, Math.trunc(num(raw.max_instances_per_host, DEFAULT_DYNAMIC_POLICY.max_instances_per_host))),
    cpu_single_overcommit: Math.max(1, num(raw.cpu_single_overcommit, DEFAULT_DYNAMIC_POLICY.cpu_single_overcommit)),
    overcommit_warn: Math.max(0, num(raw.overcommit_warn, DEFAULT_DYNAMIC_POLICY.overcommit_warn)),
    h_min: ratio(raw.h_min, DEFAULT_DYNAMIC_POLICY.h_min),
    w_floor: Math.max(0, Math.min(1e3, Math.trunc(num(raw.w_floor, DEFAULT_DYNAMIC_POLICY.w_floor)))),
    w_degrade_scope: raw.w_degrade_scope === "whole" ? "whole" : "resource",
    pressure_enter: {
      busy: ratio(enter.busy, DEFAULT_DYNAMIC_POLICY.pressure_enter.busy),
      pressure: ratio(enter.pressure, DEFAULT_DYNAMIC_POLICY.pressure_enter.pressure),
      critical: ratio(enter.critical, DEFAULT_DYNAMIC_POLICY.pressure_enter.critical)
    },
    pressure_exit: {
      busy: ratio(exit.busy, DEFAULT_DYNAMIC_POLICY.pressure_exit.busy),
      pressure: ratio(exit.pressure, DEFAULT_DYNAMIC_POLICY.pressure_exit.pressure),
      critical: ratio(exit.critical, DEFAULT_DYNAMIC_POLICY.pressure_exit.critical)
    },
    recovery_hold_seconds: Math.max(0, num(raw.recovery_hold_seconds, DEFAULT_DYNAMIC_POLICY.recovery_hold_seconds)),
    grant_update_interval_seconds: Math.max(1, num(raw.grant_update_interval_seconds, DEFAULT_DYNAMIC_POLICY.grant_update_interval_seconds)),
    reclaim_cooldown_seconds: Math.max(0, num(raw.reclaim_cooldown_seconds, DEFAULT_DYNAMIC_POLICY.reclaim_cooldown_seconds)),
    reclaim_check_window_seconds: Math.max(1, num(raw.reclaim_check_window_seconds, DEFAULT_DYNAMIC_POLICY.reclaim_check_window_seconds)),
    reclaim_max_steps: Math.max(1, Math.trunc(num(raw.reclaim_max_steps, DEFAULT_DYNAMIC_POLICY.reclaim_max_steps))),
    require_applied_before_start: raw.require_applied_before_start === void 0 ? DEFAULT_DYNAMIC_POLICY.require_applied_before_start : Boolean(raw.require_applied_before_start),
    idle_floor_cpu_millicores: Math.max(0, Math.trunc(num(raw.idle_floor_cpu_millicores, DEFAULT_DYNAMIC_POLICY.idle_floor_cpu_millicores))),
    idle_floor_mem_bytes: Math.max(0, Math.trunc(num(raw.idle_floor_mem_bytes, DEFAULT_DYNAMIC_POLICY.idle_floor_mem_bytes))),
    ewma_alpha: ratio(raw.ewma_alpha, DEFAULT_DYNAMIC_POLICY.ewma_alpha),
    dispatch_window_seconds: Math.max(1, num(raw.dispatch_window_seconds, DEFAULT_DYNAMIC_POLICY.dispatch_window_seconds))
  };
}
function computeHRes(input) {
  const uMem = input.memCapacityBytes > 0 ? Math.max(0, Math.min(1, input.usedMemBytes / input.memCapacityBytes)) : 0;
  const uCpu = input.cpuCapacityMillicores > 0 ? Math.max(0, Math.min(1, input.usedCpuMillicores / input.cpuCapacityMillicores)) : 0;
  const min = Math.max(0, Math.min(1, input.hMin));
  return Math.max(min, Math.min(1, 1 - Math.max(uMem, uCpu)));
}
function percentile25(samples) {
  const values = samples.filter((n2) => Number.isFinite(n2)).sort((a, b) => a - b);
  if (!values.length) return 0;
  const rank = Math.max(1, Math.ceil(values.length * 0.25));
  return Math.round(values[Math.min(values.length - 1, rank - 1)]);
}
function computeDemand(inputs) {
  const totalCapCpu = inputs.reduce((sum, i) => sum + Math.max(0, i.capCpuMillicores), 0);
  const totalCapMem = inputs.reduce((sum, i) => sum + Math.max(0, i.capMemBytes), 0);
  return inputs.map((i) => {
    const capCpu = Math.max(0, Math.trunc(i.capCpuMillicores));
    const capMem = Math.max(0, Math.trunc(i.capMemBytes));
    const floorCpu = Math.min(capCpu, Math.max(0, Math.trunc(i.idleFloorCpuMillicores)));
    const floorMem = Math.min(capMem, Math.max(0, Math.trunc(i.idleFloorMemBytes)));
    return {
      instanceId: i.instanceId,
      capCpuMillicores: capCpu,
      capMemBytes: capMem,
      reservedCpuMillicores: Math.max(0, Math.trunc(i.reservedCpuMillicores)),
      reservedMemBytes: Math.max(0, Math.trunc(i.reservedMemBytes)),
      demandCpuMillicores: Math.min(
        capCpu,
        Math.max(0, Math.trunc(Math.max(i.reservedCpuMillicores, i.usedCpuMillicores, floorCpu)))
      ),
      demandMemBytes: Math.min(
        capMem,
        Math.max(0, Math.trunc(Math.max(i.reservedMemBytes, i.usedMemBytes, floorMem)))
      ),
      // Normalize to per-mille integers so the water filler stays integer-only.
      weightCpu: totalCapCpu > 0 ? Math.max(1, Math.round(capCpu / totalCapCpu * 1e6)) : 1e6,
      weightMem: totalCapMem > 0 ? Math.max(1, Math.round(capMem / totalCapMem * 1e6)) : 1e6
    };
  });
}
function waterFill(capacity, items) {
  const cap = Math.max(0, Math.trunc(capacity));
  const sorted = [...items].sort((a, b) => a.instanceId.localeCompare(b.instanceId));
  const grants = /* @__PURE__ */ new Map();
  for (const item of sorted) {
    const upper = Math.max(0, Math.min(Math.trunc(item.demand), Math.trunc(item.cap)));
    const floor = Math.max(0, Math.min(upper, Math.trunc(item.floor)));
    grants.set(item.instanceId, floor);
  }
  let remaining = cap - [...grants.values()].reduce((a, b) => a + b, 0);
  if (remaining <= 0) return grants;
  const active = () => sorted.filter((item) => {
    const upper = Math.max(0, Math.min(Math.trunc(item.demand), Math.trunc(item.cap)));
    return (grants.get(item.instanceId) ?? 0) < upper;
  });
  let guard = 0;
  while (remaining > 0 && guard++ < sorted.length + 4) {
    const set = active();
    if (!set.length) break;
    const totalWeight = set.reduce((sum, i) => sum + Math.max(1, Math.trunc(i.weight)), 0);
    let added = 0;
    for (const item of set) {
      const value = grants.get(item.instanceId) ?? 0;
      const upper = Math.max(0, Math.min(Math.trunc(item.demand), Math.trunc(item.cap)));
      const room = upper - value;
      const share = Number(
        BigInt(remaining) * BigInt(Math.max(1, Math.trunc(item.weight))) / BigInt(totalWeight)
      );
      const add = Math.min(room, share, remaining - added);
      if (add > 0) {
        grants.set(item.instanceId, value + add);
        added += add;
      }
    }
    remaining -= added;
    if (added === 0) break;
  }
  let changed = true;
  while (remaining > 0 && changed) {
    changed = false;
    for (const item of sorted) {
      if (remaining <= 0) break;
      const value = grants.get(item.instanceId) ?? 0;
      const upper = Math.max(0, Math.min(Math.trunc(item.demand), Math.trunc(item.cap)));
      if (value < upper) {
        grants.set(item.instanceId, value + 1);
        remaining -= 1;
        changed = true;
      }
    }
  }
  return grants;
}
function allocateGrants(input) {
  const memCapacity = Math.max(0, Math.trunc(input.memCapacityBytes));
  const cpuCapacity = Math.max(0, Math.trunc(input.cpuCapacityMillicores));
  const memGrants = waterFill(
    memCapacity,
    input.demands.map((d) => ({
      instanceId: d.instanceId,
      cap: d.capMemBytes,
      demand: d.demandMemBytes,
      weight: d.weightMem,
      floor: Math.min(d.capMemBytes, input.policy.idle_floor_mem_bytes)
    }))
  );
  const cpuGrants = waterFill(
    cpuCapacity,
    input.demands.map((d) => ({
      instanceId: d.instanceId,
      cap: d.capCpuMillicores,
      demand: d.demandCpuMillicores,
      weight: d.weightCpu,
      floor: Math.min(d.capCpuMillicores, input.policy.idle_floor_cpu_millicores)
    }))
  );
  const pressure = String(input.pressureState ?? "NORMAL");
  const highRatio = pressure === "CRITICAL" ? 1 : pressure === "PRESSURE" ? 1.1 : 1.25;
  const minHigh = 16 * MIB;
  return input.demands.map((d) => {
    const grantMem = Math.max(0, memGrants.get(d.instanceId) ?? 0);
    const grantCpu = Math.max(0, cpuGrants.get(d.instanceId) ?? 0);
    const capMem = Math.max(0, d.capMemBytes);
    const pressureHigh = Math.max(minHigh, Math.min(capMem, Math.round(grantMem * highRatio)));
    const memoryHigh = pressure === "NORMAL" || pressure === "BUSY" ? capMem : Math.min(capMem, pressureHigh);
    const finalCpu = Math.min(grantCpu, Math.max(0, d.capCpuMillicores));
    const finalMem = Math.min(grantMem, capMem);
    return {
      instanceId: d.instanceId,
      capCpuMillicores: Math.max(0, d.capCpuMillicores),
      capMemBytes: capMem,
      demandCpuMillicores: d.demandCpuMillicores,
      demandMemBytes: d.demandMemBytes,
      grantCpuMillicores: finalCpu,
      grantMemBytes: finalMem,
      memoryLowBytes: finalMem,
      memoryHighBytes: memoryHigh,
      cpuWeight: Math.max(
        1,
        cpuCapacity > 0 ? Math.round(1e4 * finalCpu / cpuCapacity) : 1
      ),
      // A grant below already-committed reservations is an allowed temporary state; admission stops.
      overcommitted: finalCpu < d.reservedCpuMillicores || finalMem < d.reservedMemBytes
    };
  });
}
function computeConcurrency(input) {
  if (input.requestCpuMillicores <= 0 || input.requestMemBytes <= 0) return 0;
  const cpu = Math.floor(Math.max(0, input.remainingCpuMillicores) / input.requestCpuMillicores);
  const mem = Math.floor(Math.max(0, input.remainingMemBytes) / input.requestMemBytes);
  return Math.max(0, Math.min(Math.max(0, Math.trunc(input.kMax)), cpu, mem));
}
function backoffSeconds(blockedAttempts, baseSeconds, maxSeconds) {
  const base = Math.max(1, Math.trunc(baseSeconds));
  const max = Math.max(base, Math.trunc(maxSeconds));
  const n2 = Math.max(0, Math.min(6, Math.trunc(blockedAttempts)));
  return Math.min(max, base * 2 ** n2);
}
function nextPressureState(current, utilization, policy) {
  const u = Math.max(0, Math.min(1, Number.isFinite(utilization) ? utilization : 0));
  const now = String(current || "NORMAL");
  const enter = policy.pressure_enter;
  const exit = policy.pressure_exit;
  if (now === "CRITICAL") return u <= exit.critical ? "RECOVERING" : "CRITICAL";
  if (now === "PRESSURE") {
    if (u >= enter.critical) return "CRITICAL";
    return u <= exit.pressure ? "RECOVERING" : "PRESSURE";
  }
  if (now === "RECOVERING") {
    if (u >= enter.critical) return "CRITICAL";
    if (u >= enter.pressure) return "PRESSURE";
    return u <= exit.busy ? "NORMAL" : "RECOVERING";
  }
  if (now === "BUSY") {
    if (u >= enter.pressure) return "PRESSURE";
    return u <= exit.busy ? "NORMAL" : "BUSY";
  }
  if (u >= enter.critical) return "CRITICAL";
  if (u >= enter.pressure) return "PRESSURE";
  if (u >= enter.busy) return "BUSY";
  return "NORMAL";
}
function admissionAllowedByPressure(state) {
  return state === "NORMAL" || state === "BUSY" || state === "RECOVERING";
}

// scheduler/src/config.ts
function dynamicPolicyFromEnv() {
  const raw = (process.env.DYNAMIC_POLICY ?? "").trim();
  if (!raw) return normalizeDynamicPolicy({});
  try {
    return normalizeDynamicPolicy(JSON.parse(raw));
  } catch {
    console.warn("[config] DYNAMIC_POLICY is not valid JSON; using the default dynamic policy");
    return normalizeDynamicPolicy({});
  }
}
var config = {
  port: Number(process.env.PORT ?? 7801),
  // Listen on loopback by default: expose externally only through the control-plane reverse proxy + mTLS, never bind the port directly to a NIC
  host: process.env.HOST ?? "127.0.0.1",
  databaseUrl: process.env.DATABASE_URL ?? "postgres://postgres:sched_dev_pw@127.0.0.1:5432/scheduler",
  tickMs: Number(process.env.TICK_MS ?? 1e3),
  // Loop switches for production; tests call the sweep functions directly and run no loops
  loops: process.env.DISABLE_LOOPS !== "1",
  // P6: direct TLS / mTLS. Certificate and private key must be configured together.
  tlsCertFile: (process.env.SCHEDULER_TLS_CERT_FILE ?? "").trim(),
  tlsKeyFile: (process.env.SCHEDULER_TLS_KEY_FILE ?? "").trim(),
  tlsCaFile: (process.env.SCHEDULER_TLS_CA_FILE ?? "").trim(),
  mtls: process.env.SCHEDULER_MTLS === "1",
  // Federation tree: this node id, host id, parent scheduler URL and shared token.
  // Without PARENT_URL this node is the root; both root and nodes push tasks based on direct-child reports.
  nodeId: (process.env.SCHEDULER_NODE_ID ?? "").trim(),
  hostId: (process.env.SCHEDULER_HOST_ID ?? "").trim(),
  parentUrl: (process.env.SCHEDULER_PARENT_URL ?? "").trim().replace(/\/+$/, ""),
  federationToken: (process.env.SCHEDULER_FEDERATION_TOKEN ?? "").trim(),
  federationIntervalMs: Math.max(
    5e3,
    Number(process.env.SCHEDULER_FEDERATION_INTERVAL_MS ?? 3e4) || 3e4
  ),
  // This scheduler's reachable address for other schedulers in the federation. PCS injects it as "host address + host port" at deployment;
  // a child sends it to its parent with the capability report, so the parent knows where to send relayed tasks.
  advertiseUrl: (process.env.SCHEDULER_ADVERTISE_URL ?? "").trim().replace(/\/+$/, ""),
  // Period at which the parent mirrors child task state. 0 disables relay sync (forwarding only).
  relaySyncMs: Math.max(
    250,
    Number(process.env.SCHEDULER_RELAY_SYNC_MS ?? 2e3) || 2e3
  ),
  // Scheduling mode is fixed when the root scheduler is deployed and inherited by node schedulers and builders.
  schedulingMode: process.env.SCHEDULING_MODE === "dynamic" ? "dynamic" : "static",
  dynamicPolicy: dynamicPolicyFromEnv(),
  // Grant recomputation cadence; events (claim/release/pressure change) also trigger a recompute.
  grantIntervalMs: Math.max(
    1e3,
    Number(process.env.GRANT_UPDATE_INTERVAL_MS ?? 5e3) || 5e3
  )
};
if (Boolean(config.tlsCertFile) !== Boolean(config.tlsKeyFile)) {
  throw new Error("SCHEDULER_TLS_CERT_FILE and SCHEDULER_TLS_KEY_FILE must be configured together");
}
if (config.mtls && (!config.tlsCertFile || !config.tlsCaFile)) {
  throw new Error("SCHEDULER_MTLS=1 requires both a TLS certificate and a client CA (SCHEDULER_TLS_CA_FILE)");
}

// scheduler/node_modules/pg/esm/index.mjs
var import_lib = __toESM(require_lib2(), 1);
var Client = import_lib.default.Client;
var Pool = import_lib.default.Pool;
var Connection = import_lib.default.Connection;
var types = import_lib.default.types;
var Query = import_lib.default.Query;
var DatabaseError = import_lib.default.DatabaseError;
var escapeIdentifier = import_lib.default.escapeIdentifier;
var escapeLiteral = import_lib.default.escapeLiteral;
var Result = import_lib.default.Result;
var TypeOverrides = import_lib.default.TypeOverrides;
var defaults = import_lib.default.defaults;
var esm_default = import_lib.default;

// scheduler/src/db.ts
var { Pool: Pool2 } = esm_default;
var pool = new Pool2({
  connectionString: config.databaseUrl,
  max: Number(process.env.PG_POOL_MAX ?? 10),
  application_name: "scheduler"
});
async function q(sql, params = []) {
  const res = await pool.query(sql, params);
  return res.rows;
}
async function q1(sql, params = []) {
  const rows = await q(sql, params);
  return rows[0] ?? null;
}
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {
    });
    throw e;
  } finally {
    client.release();
  }
}

// scheduler/src/auth.ts
import { timingSafeEqual } from "node:crypto";

// scheduler/src/errors.ts
var ApiError = class extends Error {
  constructor(status, code, message, detail) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.name = "ApiError";
  }
  status;
  code;
  detail;
};

// scheduler/src/jwt.ts
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import fs from "node:fs";
var ISSUER = "platform-control";
var AUDIENCE = "scheduler";
function pcsPublicKeyPem() {
  const inline = process.env.PCS_PUBLIC_KEY;
  if (inline) return inline.replace(/\\n/g, "\n");
  const file = process.env.PCS_PUBLIC_KEY_FILE;
  if (file) {
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      throw new ApiError(503, "AUTH_NOT_CONFIGURED", `failed to read PCS public key: ${file}`);
    }
  }
  return null;
}
function jwtEnabled() {
  return !!pcsPublicKeyPem();
}
function parsePart(part, what) {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    throw new ApiError(401, "TOKEN_INVALID", `token ${what} is not valid JSON`);
  }
}
function verifyJwt(token, opts = {}) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new ApiError(401, "TOKEN_INVALID", "invalid token format");
  const header = parsePart(parts[0], "header");
  if (header.alg !== "ES256") {
    throw new ApiError(401, "TOKEN_INVALID", `unsupported signature algorithm: ${header.alg ?? "none"}`);
  }
  const pem = pcsPublicKeyPem();
  if (!pem) {
    throw new ApiError(503, "AUTH_NOT_CONFIGURED", "PCS public key is not configured; cannot verify signature");
  }
  let key;
  try {
    key = createPublicKey(pem);
  } catch {
    throw new ApiError(503, "AUTH_NOT_CONFIGURED", "invalid PCS public key format");
  }
  const ok = verify(
    "sha256",
    Buffer.from(`${parts[0]}.${parts[1]}`),
    { key, dsaEncoding: "ieee-p1363" },
    Buffer.from(parts[2], "base64url")
  );
  if (!ok) throw new ApiError(401, "TOKEN_INVALID", "invalid token signature");
  const claims = parsePart(parts[1], "payload");
  const skew = opts.skewSeconds ?? 60;
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1e3);
  if (typeof claims.exp !== "number") {
    throw new ApiError(401, "TOKEN_INVALID", "token is missing exp");
  }
  if (claims.exp + skew < now) throw new ApiError(401, "TOKEN_EXPIRED", "token has expired");
  if (typeof claims.nbf === "number" && claims.nbf - skew > now) {
    throw new ApiError(401, "TOKEN_INVALID", "token is not valid yet");
  }
  if (opts.issuer && claims.iss !== opts.issuer) {
    throw new ApiError(401, "TOKEN_INVALID", `untrusted issuer: ${claims.iss ?? "-"}`);
  }
  if (opts.audience) {
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(opts.audience)) {
      throw new ApiError(401, "TOKEN_INVALID", "token audience mismatch");
    }
  }
  return claims;
}
function requireScope(claims, scope) {
  const scopes = Array.isArray(claims.scopes) ? claims.scopes : [];
  if (!scopes.includes(scope)) {
    throw new ApiError(403, "ROLE_NOT_ALLOWED", `token is missing required scope: ${scope}`, {
      required: scope,
      scopes
    });
  }
}
function verifyApprovalToken(token) {
  const claims = verifyJwt(token, { issuer: ISSUER, audience: AUDIENCE });
  if (claims.typ !== "approval") {
    throw new ApiError(401, "TOKEN_INVALID", "not an approval token");
  }
  requireScope(claims, "approval:decide");
  for (const k of ["approval_request_id", "operator_id"]) {
    if (typeof claims[k] !== "string" || !claims[k]) {
      throw new ApiError(401, "TOKEN_INVALID", `approval token is missing ${k}`);
    }
  }
  if (!Array.isArray(claims.action_scope)) {
    throw new ApiError(401, "TOKEN_INVALID", "approval token is missing action_scope");
  }
  return claims;
}

// scheduler/src/auth.ts
function authToken() {
  return process.env.AUTH_TOKEN || void 0;
}
function authEnabled() {
  return jwtEnabled() || !!authToken();
}
function safeEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
function bearer(req) {
  const header = req.headers.authorization ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) throw new ApiError(401, "UNAUTHENTICATED", "missing Bearer token");
  return m[1];
}
function requireInstanceAuth(req) {
  if (jwtEnabled()) {
    const claims = verifyJwt(bearer(req), { issuer: "platform-control", audience: "scheduler" });
    if (!claims.sub) throw new ApiError(401, "TOKEN_INVALID", "instance token is missing sub");
    return {
      kind: "jwt",
      instance_id: claims.sub,
      scopes: Array.isArray(claims.scopes) ? claims.scopes : [],
      claims
    };
  }
  const expected = authToken();
  if (!expected) return null;
  if (!safeEqual(bearer(req), expected)) {
    throw new ApiError(401, "UNAUTHENTICATED", "invalid token");
  }
  return { kind: "shared", instance_id: null, scopes: [] };
}
function assertSelf(auth, instanceId) {
  if (auth?.kind !== "jwt") return;
  if (!instanceId || instanceId !== auth.instance_id) {
    throw new ApiError(403, "ROLE_NOT_ALLOWED", "instance tokens may only operate on their own instance", {
      token_sub: auth.instance_id,
      requested: instanceId ?? null
    });
  }
}
function requireApprovalConfigured() {
  if (!jwtEnabled()) {
    throw new ApiError(503, "APPROVAL_NOT_CONFIGURED", "PCS public key is not configured; approval endpoints are unavailable");
  }
}

// scheduler/src/http/server.ts
import fs3 from "node:fs";
import http from "node:http";
import https from "node:https";

// scheduler/src/events.ts
async function appendEvent(c, e) {
  await c.query(
    `INSERT INTO task_events (task_id, event_type, from_status, to_status, actor, payload, trace_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      e.task_id,
      e.event_type,
      e.from_status ?? null,
      e.to_status ?? null,
      e.actor ?? null,
      e.payload === void 0 ? null : JSON.stringify(e.payload),
      e.trace_id ?? null
    ]
  );
  const version = (await c.query(`SELECT version FROM tasks WHERE task_id = $1`, [e.task_id])).rows[0]?.version;
  await c.query(
    `INSERT INTO outbox_events
       (event_type, schema_version, aggregate_type, aggregate_id, aggregate_version,
        trace_id, actor_id, idempotency_key, payload)
     VALUES ($1, '1.0', 'task', $2, $3, $4, $5, $6, $7)`,
    [
      e.event_type,
      e.task_id,
      version ?? null,
      e.trace_id ?? null,
      e.actor ?? null,
      `${e.task_id}:${e.event_type}:${version ?? 0}`,
      JSON.stringify({
        task_id: e.task_id,
        from_status: e.from_status ?? null,
        to_status: e.to_status ?? null,
        ...e.payload && typeof e.payload === "object" ? { payload: e.payload } : {}
      })
    ]
  );
}

// scheduler/src/ids.ts
import { createHash, randomBytes } from "node:crypto";
function newId(prefix) {
  return `${prefix}_${randomBytes(9).toString("base64url")}`;
}
function newToken() {
  return randomBytes(24).toString("base64url");
}

// scheduler/src/capability.ts
var CAPABILITY_WEIGHTS = {
  cores: 0.3,
  freq_ghz: 0.15,
  mem_gb: 0.2,
  disk_gb: 0.1,
  model: 0.15,
  api: 0.1
};
var CAPABILITY_CEILINGS = {
  cores: 8,
  freq_ghz: 4,
  mem_gb: 32,
  disk_gb: 256,
  model: 10,
  api: 10
};
function ratio2(value, ceiling) {
  const n2 = Number(value);
  if (!Number.isFinite(n2) || n2 <= 0) return 0;
  return Math.min(n2 / ceiling, 1);
}
function computeCapabilityScore(detail) {
  if (!detail) return 0;
  const raw = CAPABILITY_WEIGHTS.cores * ratio2(detail.cores, CAPABILITY_CEILINGS.cores) + CAPABILITY_WEIGHTS.freq_ghz * ratio2(detail.freq_ghz, CAPABILITY_CEILINGS.freq_ghz) + CAPABILITY_WEIGHTS.mem_gb * ratio2(detail.mem_gb, CAPABILITY_CEILINGS.mem_gb) + CAPABILITY_WEIGHTS.disk_gb * ratio2(detail.disk_gb, CAPABILITY_CEILINGS.disk_gb) + CAPABILITY_WEIGHTS.model * ratio2(detail.model, CAPABILITY_CEILINGS.model) + CAPABILITY_WEIGHTS.api * ratio2(detail.api, CAPABILITY_CEILINGS.api);
  return Math.max(0, Math.min(1e3, Math.round(raw * 1e3)));
}
function splitCapability(detail, cap) {
  const d = normalizeCapabilityDetail(detail ?? {});
  const staticRaw = CAPABILITY_WEIGHTS.freq_ghz * ratio2(d.freq_ghz, CAPABILITY_CEILINGS.freq_ghz) + CAPABILITY_WEIGHTS.disk_gb * ratio2(d.disk_gb, CAPABILITY_CEILINGS.disk_gb) + CAPABILITY_WEIGHTS.model * ratio2(d.model, CAPABILITY_CEILINGS.model) + CAPABILITY_WEIGHTS.api * ratio2(d.api, CAPABILITY_CEILINGS.api);
  const cores = cap?.cpu_cores ?? d.cores ?? 0;
  const memGb = cap?.mem_gb ?? d.mem_gb ?? 0;
  const resRaw = CAPABILITY_WEIGHTS.cores * ratio2(cores, CAPABILITY_CEILINGS.cores) + CAPABILITY_WEIGHTS.mem_gb * ratio2(memGb, CAPABILITY_CEILINGS.mem_gb);
  const staticScore = Math.max(0, Math.min(500, Math.round(staticRaw * 1e3)));
  const resScore = Math.max(0, Math.min(500, Math.round(resRaw * 1e3)));
  return { static_score: staticScore, res_score: resScore, ceiling: staticScore + resScore };
}
function dynamicLiveScore(split, hRes, opts = {}) {
  const h = Number.isFinite(hRes) ? Math.max(0, Math.min(1, hRes)) : 1;
  if ((opts.scope ?? "resource") === "whole") {
    const floor = Math.max(0, Math.min(1e3, Number(opts.wFloor ?? 0)));
    return Math.max(floor, Math.round(split.ceiling * h));
  }
  return Math.max(0, Math.min(1e3, Math.round(split.static_score + h * split.res_score)));
}
function dynamicGuaranteedScore(split, minShare) {
  const res = CAPABILITY_WEIGHTS.cores * ratio2(minShare.cpu_cores, CAPABILITY_CEILINGS.cores) + CAPABILITY_WEIGHTS.mem_gb * ratio2(minShare.mem_gb, CAPABILITY_CEILINGS.mem_gb);
  return Math.max(0, Math.min(1e3, Math.round(split.static_score + res * 1e3)));
}
function normalizeCapabilityDetail(detail) {
  if (!detail || typeof detail !== "object") return {};
  const d = detail;
  const out = {};
  for (const key of Object.keys(CAPABILITY_WEIGHTS)) {
    const n2 = Number(d[key]);
    if (Number.isFinite(n2) && n2 >= 0) out[key] = n2;
  }
  return out;
}
function normalizeDifficulty(value) {
  const n2 = Number(value);
  if (!Number.isFinite(n2) || n2 <= 0) return 0;
  return Math.min(1e3, Math.round(n2));
}

// scheduler/src/repo/resources.ts
var GIB = 1024 ** 3;
var n = (value) => {
  const x = Number(value);
  return Number.isFinite(x) ? x : 0;
};
var floorNonNeg = (value) => Math.max(0, Math.trunc(n(value)));
function policyForScheduler(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || !Object.keys(input).length) {
    return config.dynamicPolicy;
  }
  const raw = input;
  const base = config.dynamicPolicy;
  return normalizeDynamicPolicy({
    ...base,
    ...raw,
    pressure_enter: { ...base.pressure_enter, ...raw.pressure_enter ?? {} },
    pressure_exit: { ...base.pressure_exit, ...raw.pressure_exit ?? {} }
  });
}
async function getPool(c, hostId) {
  await c.query(
    `INSERT INTO host_resource_pools (host_id, cpu_total_millicores, mem_total_bytes)
     SELECT host_id, GREATEST(cpu_total, 0) * 1000, GREATEST(mem_total_bytes, 0)
       FROM hosts WHERE host_id = $1
     ON CONFLICT (host_id) DO NOTHING`,
    [hostId]
  );
  const row = (await c.query(
    `SELECT p.*, h.host_state
         FROM host_resource_pools p JOIN hosts h USING (host_id)
        WHERE p.host_id = $1`,
    [hostId]
  )).rows[0];
  return {
    ...row,
    cpu_total_millicores: n(row?.cpu_total_millicores),
    mem_total_bytes: n(row?.mem_total_bytes),
    cpu_granted_millicores: n(row?.cpu_granted_millicores),
    mem_granted_bytes: n(row?.mem_granted_bytes),
    cpu_used_millicores: n(row?.cpu_used_millicores),
    mem_used_bytes: n(row?.mem_used_bytes),
    mem_working_set_bytes: n(row?.mem_working_set_bytes),
    available_commitment_bytes: n(row?.available_commitment_bytes)
  };
}
async function getGrants(hostId) {
  return grantsWith(pool, hostId);
}
function mapGrant(r) {
  return {
    host_id: String(r.host_id),
    instance_id: String(r.instance_id),
    generation: n(r.generation),
    cpu_millicores: n(r.cpu_millicores),
    memory_bytes: n(r.memory_bytes),
    memory_low_bytes: n(r.memory_low_bytes),
    memory_high_bytes: n(r.memory_high_bytes),
    cpu_weight: n(r.cpu_weight),
    cap_cpu_millicores: r.cap_cpu_millicores === void 0 ? void 0 : n(r.cap_cpu_millicores),
    cap_mem_bytes: r.cap_mem_bytes === void 0 ? void 0 : n(r.cap_mem_bytes),
    state: String(r.state),
    applied_generation: r.applied_generation === null ? null : n(r.applied_generation),
    applied_at: r.applied_at ?? null,
    last_error: r.last_error ?? null,
    updated_at: String(r.updated_at)
  };
}
async function grantsWith(c, hostId) {
  const rows = (await c.query(
    `SELECT g.*, r.cap_cpu_millicores, r.cap_mem_bytes
         FROM resource_grants g
         JOIN role_instances r USING (instance_id)
        WHERE g.host_id = $1
        ORDER BY g.instance_id`,
    [hostId]
  )).rows;
  return rows.map(mapGrant);
}
async function getInstanceGrantState(instanceId) {
  const owner = await q1(
    `SELECT instance_id, host_id, scheduling_mode FROM role_instances WHERE instance_id = $1`,
    [instanceId]
  );
  if (!owner) return null;
  const grant = await q1(
    `SELECT g.*, r.cap_cpu_millicores, r.cap_mem_bytes
       FROM resource_grants g
       JOIN role_instances r USING (instance_id)
      WHERE g.instance_id = $1`,
    [instanceId]
  );
  const pool2 = await q1(
    `SELECT * FROM host_resource_pools WHERE host_id = $1`,
    [owner.host_id]
  );
  return {
    instance_id: String(owner.instance_id),
    host_id: String(owner.host_id),
    scheduling_mode: typeof owner.scheduling_mode === "string" ? owner.scheduling_mode : "static",
    grant: grant ? mapGrant(grant) : null,
    pool: pool2 ? {
      ...pool2,
      cpu_total_millicores: n(pool2.cpu_total_millicores),
      mem_total_bytes: n(pool2.mem_total_bytes),
      cpu_granted_millicores: n(pool2.cpu_granted_millicores),
      mem_granted_bytes: n(pool2.mem_granted_bytes),
      cpu_used_millicores: n(pool2.cpu_used_millicores),
      mem_used_bytes: n(pool2.mem_used_bytes),
      mem_working_set_bytes: n(pool2.mem_working_set_bytes),
      available_commitment_bytes: n(pool2.available_commitment_bytes)
    } : null
  };
}
async function markGrantApplied(input) {
  if (!input.host_id || !input.instance_id) throw new Error("host_id / instance_id are required");
  const row = await q1(
    `UPDATE resource_grants
        SET state = CASE WHEN $3::bigint >= generation THEN 'APPLIED' ELSE 'SUPERSEDED' END,
            applied_generation = $3::bigint,
            applied_cpu_millicores = $4,
            applied_memory_bytes = $5,
            applied_memory_low_bytes = $6,
            applied_memory_high_bytes = $7,
            applied_cpu_weight = $8,
            applied_at = CASE WHEN $3::bigint >= generation THEN app_now() ELSE applied_at END,
            last_error = NULL,
            updated_at = app_now()
      WHERE host_id = $1 AND instance_id = $2
      RETURNING state`,
    [
      input.host_id,
      input.instance_id,
      Math.trunc(input.generation),
      input.cpu_millicores ?? null,
      input.memory_bytes ?? null,
      input.memory_low_bytes ?? null,
      input.memory_high_bytes ?? null,
      input.cpu_weight ?? null
    ]
  );
  return { applied: Boolean(row), state: String(row?.state ?? "UNKNOWN") };
}
async function markGrantFailed(input) {
  await q(
    `UPDATE resource_grants
        SET state = CASE WHEN $3::bigint >= generation THEN 'FAILED' ELSE state END,
            last_error = $4, updated_at = app_now()
      WHERE host_id = $1 AND instance_id = $2`,
    [input.host_id, input.instance_id, Math.trunc(input.generation), String(input.error).slice(0, 500)]
  );
}
function capOf(row, pool2) {
  const detail = row.capability_detail ?? {};
  const detailCpu = Math.max(0, Math.round(n(detail.cores) * 1e3));
  const detailMem = Math.max(0, Math.round(n(detail.mem_gb) * GIB));
  const fallbackCpu = Math.max(1, Math.floor(pool2.cpu_total_millicores / 4));
  const fallbackMem = Math.max(256 * 1024 ** 2, Math.floor(pool2.mem_total_bytes / 8));
  return {
    cpu: Math.max(1, floorNonNeg(row.cap_cpu_millicores) || detailCpu || fallbackCpu),
    mem: Math.max(1, floorNonNeg(row.cap_mem_bytes) || detailMem || fallbackMem)
  };
}
async function demandRows(c, hostId) {
  const rows = (await c.query(
    `SELECT r.instance_id, r.state, r.scheduling_mode, r.capability_score,
              r.capability_detail, r.cap_cpu_millicores, r.cap_mem_bytes,
              r.usage_cpu_millicores, r.usage_mem_bytes,
              r.capability_ceiling_score,
              COALESCE(SUM(p.cpu_millicores) FILTER (WHERE l.released_at IS NULL AND l.expires_at > app_now()), 0)::int AS reserved_cpu_millicores,
              COALESCE(SUM(p.memory_bytes) FILTER (WHERE l.released_at IS NULL AND l.expires_at > app_now()), 0)::bigint AS reserved_mem_bytes
         FROM role_instances r
         LEFT JOIN leases l ON l.instance_id = r.instance_id
         LEFT JOIN tasks t ON t.task_id = l.task_id
         LEFT JOIN resource_profiles p ON p.profile_id = t.resource_profile_id
        -- Any instance explicitly switched to dynamic mode is grant-managed, even when it keeps a
        -- legacy role id (the role name is historical; scheduling_mode is what selects the ledger).
        WHERE r.host_id = $1 AND (r.role_id = 'builder' OR r.scheduling_mode = 'dynamic')
          AND r.state NOT IN ('OFFLINE','FAILED')
        GROUP BY r.instance_id
        ORDER BY r.instance_id`,
    [hostId]
  )).rows;
  return rows.map((r) => ({
    ...r,
    capability_score: n(r.capability_score),
    cap_cpu_millicores: n(r.cap_cpu_millicores),
    cap_mem_bytes: n(r.cap_mem_bytes),
    usage_cpu_millicores: n(r.usage_cpu_millicores),
    usage_mem_bytes: n(r.usage_mem_bytes),
    reserved_cpu_millicores: n(r.reserved_cpu_millicores),
    reserved_mem_bytes: n(r.reserved_mem_bytes),
    capability_ceiling_score: n(r.capability_ceiling_score)
  }));
}
var liveHistory = /* @__PURE__ */ new Map();
function rememberAndPercentile(instanceId, score, windowSeconds) {
  const now = Date.now();
  const cutoff = now - windowSeconds * 1e3;
  const list = (liveHistory.get(instanceId) ?? []).filter((x) => x.at >= cutoff);
  list.push({ at: now, score });
  liveHistory.set(instanceId, list);
  return percentile25(list.map((x) => x.score));
}
async function recomputeHostGrants(c, hostId, policy = config.dynamicPolicy) {
  await c.query(`SELECT host_id FROM hosts WHERE host_id = $1 FOR UPDATE`, [hostId]);
  const pool2 = await getPool(c, hostId);
  if (!pool2.mem_total_bytes && !pool2.cpu_total_millicores) return null;
  const memCapacity = Math.max(0, pool2.mem_total_bytes);
  const cpuCapacity = Math.max(0, pool2.cpu_total_millicores);
  const rawUsedMem = pool2.mem_working_set_bytes > 0 ? pool2.mem_working_set_bytes : pool2.mem_used_bytes;
  const hRes = computeHRes({
    usedMemBytes: rawUsedMem,
    memCapacityBytes: memCapacity,
    usedCpuMillicores: pool2.cpu_used_millicores,
    cpuCapacityMillicores: cpuCapacity,
    hMin: policy.h_min
  });
  const utilization = Math.max(
    memCapacity > 0 ? rawUsedMem / memCapacity : 0,
    cpuCapacity > 0 ? pool2.cpu_used_millicores / cpuCapacity : 0
  );
  const pressureState = nextPressureState(pool2.pressure_state, utilization, policy);
  const rows = await demandRows(c, hostId);
  const dynamicRows = rows.filter((r) => r.scheduling_mode === "dynamic");
  const capPairs = /* @__PURE__ */ new Map();
  for (const row of rows) capPairs.set(row.instance_id, capOf(row, pool2));
  const demands = computeDemand(
    dynamicRows.map((row) => {
      const cap = capPairs.get(row.instance_id);
      return {
        instanceId: row.instance_id,
        capCpuMillicores: cap.cpu,
        capMemBytes: cap.mem,
        reservedCpuMillicores: row.reserved_cpu_millicores,
        reservedMemBytes: row.reserved_mem_bytes,
        usedCpuMillicores: row.usage_cpu_millicores,
        usedMemBytes: row.usage_mem_bytes,
        idleFloorCpuMillicores: policy.idle_floor_cpu_millicores,
        idleFloorMemBytes: policy.idle_floor_mem_bytes
      };
    })
  );
  const grants = allocateGrants({
    cpuCapacityMillicores: cpuCapacity,
    memCapacityBytes: memCapacity,
    demands,
    pressureState,
    policy
  });
  const existing = new Map(
    (await grantsWith(c, hostId)).map((g) => [g.instance_id, g])
  );
  for (const grant of grants) {
    const prev = existing.get(grant.instanceId);
    const changed = !prev || prev.cpu_millicores !== grant.grantCpuMillicores || prev.memory_bytes !== grant.grantMemBytes || prev.memory_low_bytes !== grant.memoryLowBytes || prev.memory_high_bytes !== grant.memoryHighBytes || prev.cpu_weight !== grant.cpuWeight;
    if (!changed) continue;
    const generation = (prev?.generation ?? 0) + 1;
    await c.query(
      `INSERT INTO resource_grants
         (host_id, instance_id, generation, cpu_millicores, memory_bytes,
          memory_low_bytes, memory_high_bytes, cpu_weight, state, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'PENDING',app_now())
       ON CONFLICT (host_id, instance_id) DO UPDATE SET
         generation = EXCLUDED.generation,
         cpu_millicores = EXCLUDED.cpu_millicores,
         memory_bytes = EXCLUDED.memory_bytes,
         memory_low_bytes = EXCLUDED.memory_low_bytes,
         memory_high_bytes = EXCLUDED.memory_high_bytes,
         cpu_weight = EXCLUDED.cpu_weight,
         state = 'PENDING',
         updated_at = app_now()`,
      [
        hostId,
        grant.instanceId,
        generation,
        grant.grantCpuMillicores,
        grant.grantMemBytes,
        grant.memoryLowBytes,
        grant.memoryHighBytes,
        grant.cpuWeight
      ]
    );
    await c.query(
      `INSERT INTO outbox_events
         (event_type, aggregate_type, aggregate_id, aggregate_version, actor_id, payload)
       VALUES ('INSTANCE_GRANT_UPDATED', 'instance', $1, $2, 'scheduler', $3::jsonb)`,
      [
        grant.instanceId,
        generation,
        JSON.stringify({
          host_id: hostId,
          generation,
          cpu_millicores: grant.grantCpuMillicores,
          memory_bytes: grant.grantMemBytes,
          memory_low_bytes: grant.memoryLowBytes,
          memory_high_bytes: grant.memoryHighBytes,
          cpu_weight: grant.cpuWeight,
          pressure_state: pressureState
        })
      ]
    );
  }
  const grantByInstance = new Map(grants.map((g) => [g.instanceId, g]));
  const totalCaps = [...capPairs.values()];
  const sumCpu = totalCaps.reduce((s, x) => s + x.cpu, 0) || 1;
  const sumMem = totalCaps.reduce((s, x) => s + x.mem, 0) || 1;
  for (const row of rows) {
    const cap = capPairs.get(row.instance_id);
    const split = splitCapability(row.capability_detail, {
      cpu_cores: cap.cpu / 1e3,
      mem_gb: cap.mem / GIB
    });
    const dynamic = row.scheduling_mode === "dynamic";
    const live = dynamic ? dynamicLiveScore(split, hRes, { scope: policy.w_degrade_scope, wFloor: policy.w_floor }) : Math.round(row.capability_score);
    const dispatch = dynamic ? rememberAndPercentile(row.instance_id, live, policy.dispatch_window_seconds) : live;
    const guaranteed = dynamic ? dynamicGuaranteedScore(split, {
      cpu_cores: cpuCapacity * cap.cpu / sumCpu / 1e3,
      mem_gb: memCapacity * cap.mem / sumMem / GIB
    }) : Math.round(row.capability_score);
    await c.query(
      `UPDATE role_instances
          SET cap_cpu_millicores = $2,
              cap_mem_bytes = $3,
              capability_static_score = $4,
              capability_ceiling_score = $5,
              capability_live_score = $6,
              capability_dispatch_score = $7,
              capability_guaranteed_score = $8,
              capability_schema_version = 1,
              capability_updated_at = app_now()
        WHERE instance_id = $1`,
      [
        row.instance_id,
        cap.cpu,
        cap.mem,
        split.static_score,
        dynamic ? split.ceiling : Math.round(row.capability_score),
        live,
        dispatch,
        guaranteed
      ]
    );
    if (!dynamic) {
      await c.query(
        `UPDATE role_instances
            SET capability_ceiling_score = capability_score,
                capability_live_score = capability_score,
                capability_dispatch_score = capability_score,
                capability_guaranteed_score = capability_score
          WHERE instance_id = $1`,
        [row.instance_id]
      );
    }
    const grant = grantByInstance.get(row.instance_id);
    if (grant && grant.overcommitted) {
      await c.query(
        `INSERT INTO outbox_events
           (event_type, aggregate_type, aggregate_id, actor_id, payload)
         VALUES ('INSTANCE_OVERCOMMITTED', 'instance', $1, 'scheduler', $2::jsonb)`,
        [
          row.instance_id,
          JSON.stringify({
            host_id: hostId,
            grant_cpu_millicores: grant.grantCpuMillicores,
            grant_mem_bytes: grant.grantMemBytes,
            reserved_cpu_millicores: row.reserved_cpu_millicores,
            reserved_mem_bytes: row.reserved_mem_bytes
          })
        ]
      );
    }
  }
  await c.query(
    `DELETE FROM resource_grants
      WHERE host_id = $1 AND NOT (instance_id = ANY($2::text[]))`,
    [hostId, grants.map((g) => g.instanceId)]
  );
  const grantedCpu = grants.reduce((s, g) => s + g.grantCpuMillicores, 0);
  const grantedMem = grants.reduce((s, g) => s + g.grantMemBytes, 0);
  await c.query(
    `UPDATE host_resource_pools
        SET cpu_granted_millicores = $2,
            mem_granted_bytes = $3,
            available_commitment_bytes = GREATEST(0::bigint, $4::bigint - $3::bigint),
            pressure_state = $5,
            updated_at = app_now()
      WHERE host_id = $1`,
    [hostId, grantedCpu, grantedMem, memCapacity, pressureState]
  );
  if (pressureState !== pool2.pressure_state) {
    await c.query(
      `INSERT INTO outbox_events
         (event_type, aggregate_type, aggregate_id, actor_id, payload)
       VALUES ('HOST_PRESSURE_CHANGED', 'host', $1, 'scheduler', $2::jsonb)`,
      [
        hostId,
        JSON.stringify({
          host_id: hostId,
          from: pool2.pressure_state,
          to: pressureState,
          utilization,
          h_res: hRes
        })
      ]
    );
  }
  return { host_id: hostId, grants, pressure_state: pressureState };
}
async function recomputeAllGrants(policy = config.dynamicPolicy) {
  const rows = await q(`SELECT host_id FROM host_resource_pools ORDER BY host_id`);
  const out = [];
  for (const row of rows) {
    const result = await tx((c) => recomputeHostGrants(c, String(row.host_id), policy));
    if (result) {
      out.push({
        host_id: result.host_id,
        grants: result.grants.length,
        pressure_state: result.pressure_state
      });
    }
  }
  return out;
}
async function instanceResourceState(c, instanceId) {
  const row = (await c.query(
    `SELECT r.instance_id, r.host_id, r.scheduling_mode
         FROM role_instances r WHERE r.instance_id = $1`,
    [instanceId]
  )).rows[0];
  if (!row) return null;
  const reserved = (await c.query(
    `SELECT COALESCE(SUM(p.cpu_millicores),0)::int AS cpu,
              COALESCE(SUM(p.memory_bytes),0)::bigint AS mem
         FROM leases l
         JOIN tasks t ON t.task_id = l.task_id
         JOIN resource_profiles p ON p.profile_id = t.resource_profile_id
        WHERE l.instance_id = $1 AND l.released_at IS NULL AND l.expires_at > app_now()`,
    [instanceId]
  )).rows[0];
  const grant = (await c.query(
    `SELECT * FROM resource_grants WHERE instance_id = $1 LIMIT 1`,
    [instanceId]
  )).rows[0] ?? null;
  const pool2 = await getPool(c, String(row.host_id));
  const siblings = (await demandRows(c, String(row.host_id))).filter(
    (r) => r.scheduling_mode === "dynamic"
  );
  const capPairs = new Map(
    siblings.map((r) => [r.instance_id, capOf(r, pool2)])
  );
  const own = capPairs.get(instanceId) ?? { cpu: 0, mem: 0 };
  const sumCpu = [...capPairs.values()].reduce((s, x) => s + x.cpu, 0);
  const sumMem = [...capPairs.values()].reduce((s, x) => s + x.mem, 0);
  return {
    mode: String(row.scheduling_mode ?? "static"),
    grant: grant ? {
      ...grant,
      generation: n(grant.generation),
      cpu_millicores: n(grant.cpu_millicores),
      memory_bytes: n(grant.memory_bytes),
      memory_low_bytes: n(grant.memory_low_bytes),
      memory_high_bytes: n(grant.memory_high_bytes),
      cpu_weight: n(grant.cpu_weight),
      applied_generation: grant.applied_generation === null ? null : n(grant.applied_generation)
    } : null,
    reservedCpuMillicores: n(reserved?.cpu),
    reservedMemBytes: n(reserved?.mem),
    fairShareCpuMillicores: sumCpu > 0 ? Math.floor(pool2.cpu_total_millicores * own.cpu / sumCpu) : 0,
    fairShareMemBytes: sumMem > 0 ? Math.floor(pool2.mem_total_bytes * own.mem / sumMem) : 0,
    pool: pool2
  };
}

// scheduler/src/core/claim.ts
async function loadConfig(c) {
  const res = await c.query("SELECT * FROM scheduler_config WHERE id = TRUE");
  return res.rows[0];
}
async function countActive(c, sql, params) {
  const res = await c.query(sql, params);
  return res.rows[0].n;
}
var dynamicScoreOf = (inst) => {
  const dispatch = Number(inst.capability_dispatch_score ?? 0);
  if (dispatch > 0) return dispatch;
  const live = Number(inst.capability_live_score ?? 0);
  if (live > 0) return live;
  return Number(inst.capability_score ?? 0);
};
var CAPABILITY_PREFER_WINDOW_SECONDS = 30;
async function loadIdlePeers(c, inst) {
  const rows = (await c.query(
    `SELECT p.*
         FROM role_instances p
         JOIN hosts h ON h.host_id = p.host_id
        WHERE p.role_id = $1
          AND p.instance_id <> $2
          AND p.state = 'ONLINE'
          AND p.agent_profile_id IS NOT NULL
          AND h.host_state IN ('NORMAL','WARNING')
          AND NOT EXISTS (
            SELECT 1 FROM leases l
             WHERE l.instance_id = p.instance_id
               AND l.released_at IS NULL AND l.expires_at > app_now()
          )`,
    [inst.role_id, inst.instance_id]
  )).rows;
  return rows.map((row) => ({ row, score: dynamicScoreOf(row) }));
}
function peerCanTakeTask(p, task) {
  const allowedTypes = Array.isArray(p.allowed_task_types) ? p.allowed_task_types : [];
  const schemas = Array.isArray(p.payload_schemas) ? p.payload_schemas : [];
  if (!allowedTypes.includes(task.task_type)) return false;
  if (!schemas.includes(task.payload_schema)) return false;
  const target = task.requirements?.target_instance_id;
  if (target && target !== p.instance_id) return false;
  const needed = task.requirements?.capabilities ?? [];
  const healthy = p.capabilities?.healthy ?? [];
  const unhealthy = p.capabilities?.unhealthy ?? [];
  if (needed.some((x) => !healthy.includes(x) || unhealthy.includes(x))) return false;
  const score = dynamicScoreOf(p);
  if (score > 0 && Number(task.difficulty ?? 0) > score) return false;
  return true;
}
async function claim(input) {
  if (!input.instance_id) throw new ApiError(400, "BAD_REQUEST", "instance_id is required");
  return tx(async (c) => {
    const cfg = await loadConfig(c);
    const policy = policyForScheduler(cfg?.dynamic_policy);
    const owner = (await c.query(
      `SELECT host_id FROM role_instances WHERE instance_id = $1`,
      [input.instance_id]
    )).rows[0];
    if (!owner) throw new ApiError(404, "INSTANCE_UNKNOWN", `instance not registered: ${input.instance_id}`);
    const hostRes = await c.query(
      `SELECT * FROM hosts WHERE host_id = $1 FOR NO KEY UPDATE`,
      [owner.host_id]
    );
    const host = hostRes.rows[0];
    if (!host) throw new ApiError(409, "HOST_UNKNOWN", `host not registered: ${owner.host_id}`);
    const instRes = await c.query(
      `SELECT * FROM role_instances WHERE instance_id = $1 FOR UPDATE`,
      [input.instance_id]
    );
    const inst = instRes.rows[0];
    if (!inst) throw new ApiError(404, "INSTANCE_UNKNOWN", `instance not registered: ${input.instance_id}`);
    if (inst.host_id !== host.host_id) {
      throw new ApiError(409, "HOST_CHANGED", `host of instance ${inst.instance_id} has changed to ${inst.host_id}`);
    }
    if (inst.state !== "ONLINE") {
      throw new ApiError(409, "INSTANCE_NOT_ELIGIBLE", `instance state is ${inst.state}; only ONLINE instances can claim`);
    }
    if (!inst.agent_profile_id) {
      throw new ApiError(409, "INSTANCE_NOT_ELIGIBLE", "instance is not bound to an Agent Profile");
    }
    if (host.host_state !== "NORMAL" && host.host_state !== "WARNING") {
      throw new ApiError(409, "HOST_NOT_ELIGIBLE", `host ${host.host_id} is in state ${host.host_state}; dispatching paused`);
    }
    const mode = inst.scheduling_mode === "dynamic" ? "dynamic" : "static";
    if (mode === "static") {
      const instanceActive = await countActive(
        c,
        `SELECT count(*)::int AS n FROM leases
          WHERE instance_id = $1 AND released_at IS NULL AND expires_at > app_now()`,
        [inst.instance_id]
      );
      if (instanceActive >= cfg.instance_limit) {
        return null;
      }
    }
    let res = mode === "dynamic" ? await instanceResourceState(c, inst.instance_id) : null;
    if (mode === "dynamic" && !res?.grant) {
      await recomputeHostGrants(c, host.host_id, policy);
      res = await instanceResourceState(c, inst.instance_id);
    }
    const globalActive = await countActive(
      c,
      `SELECT count(*)::int AS n FROM leases WHERE released_at IS NULL AND expires_at > app_now()`,
      []
    );
    if (globalActive >= cfg.global_limit) return null;
    const roleActive = await countActive(
      c,
      `SELECT count(*)::int AS n
         FROM leases l JOIN role_instances i USING (instance_id)
        WHERE i.role_id = $1 AND l.released_at IS NULL AND l.expires_at > app_now()`,
      [inst.role_id]
    );
    if (roleActive >= cfg.role_pool_limit) return null;
    const capabilities = inst.capabilities?.healthy ?? [];
    const unhealthy = inst.capabilities?.unhealthy ?? [];
    const usable = capabilities.filter((x) => !unhealthy.includes(x));
    const capabilityScore = mode === "dynamic" ? dynamicScoreOf(inst) : Number(inst.capability_score ?? 0);
    const maxScan = Math.max(1, Number(cfg.max_candidate_scan ?? 20));
    const candidateSql = `
      SELECT t.*,
             effective_priority(t.priority_class, t.enqueued_at, $1) AS effective_priority,
             EXTRACT(EPOCH FROM (app_now() - t.enqueued_at))::int AS waited_seconds
        FROM tasks t
        JOIN task_definitions td ON td.task_type = t.task_type
       WHERE t.status = 'QUEUED'
         -- Tasks already pushed down to child nodes stay QUEUED locally for results, but must not be claimed locally.
         AND NOT EXISTS (
           SELECT 1 FROM task_relays r
            WHERE r.parent_task_id = t.task_id AND r.state = 'ACTIVE'
         )
         AND t.unschedulable = FALSE
         AND (t.resource_retry_after IS NULL OR t.resource_retry_after <= app_now())
         AND td.target_role = $2
         AND t.task_type = ANY($3::text[])
         AND (t.next_attempt_at IS NULL OR t.next_attempt_at <= app_now())
         AND COALESCE(t.requirements->'capabilities', '[]'::jsonb) <@ $4::jsonb
         AND t.payload_schema = ANY($5::text[])
         AND (
           t.requirements->>'target_instance_id' IS NULL
           OR t.requirements->>'target_instance_id' = $6
         )
         AND ($7 <= 0 OR t.difficulty <= $7)
       ORDER BY effective_priority ASC, t.enqueued_at ASC, t.task_id ASC
       FOR UPDATE OF t SKIP LOCKED
       LIMIT $8`;
    const cand = await c.query(candidateSql, [
      cfg.aging_after_seconds,
      inst.role_id,
      inst.allowed_task_types,
      JSON.stringify(usable),
      inst.payload_schemas,
      inst.instance_id,
      capabilityScore,
      maxScan
    ]);
    const ctx = { cfg, inst, host, mode, res, policy };
    let idlePeers = null;
    const strongerIdlePeer = async (task) => {
      if (Number(task.waited_seconds ?? 0) >= CAPABILITY_PREFER_WINDOW_SECONDS) return false;
      idlePeers ??= await loadIdlePeers(c, inst);
      return idlePeers.some((p) => p.score > capabilityScore && peerCanTakeTask(p.row, task));
    };
    for (const task of cand.rows) {
      const blocked = await admit(c, ctx, task);
      if (blocked) {
        if (blocked.halt) return null;
        await recordBlock(c, task, blocked, cfg, input.trace_id);
        continue;
      }
      if (await strongerIdlePeer(task)) continue;
      const assignment = await assign(c, cfg, inst, host, task, input.trace_id, mode, res?.grant ?? null);
      if (mode === "dynamic") {
        await recomputeHostGrants(c, host.host_id, policy);
        const fresh = await instanceResourceState(c, inst.instance_id);
        if (fresh?.grant) {
          assignment.resource_grant = {
            generation: fresh.grant.generation,
            state: fresh.grant.state,
            cpu_millicores: fresh.grant.cpu_millicores,
            memory_bytes: fresh.grant.memory_bytes,
            memory_low_bytes: fresh.grant.memory_low_bytes,
            memory_high_bytes: fresh.grant.memory_high_bytes,
            cpu_weight: fresh.grant.cpu_weight
          };
        }
      }
      return assignment;
    }
    return null;
  });
}
async function recordBlock(c, task, blocked, cfg, traceId) {
  const attempts = Number(task.blocked_attempts ?? 0) + 1;
  const delay = backoffSeconds(
    attempts - 1,
    Number(cfg.backoff_base_seconds ?? 1),
    Number(cfg.backoff_max_seconds ?? 60)
  );
  const unschedulable = blocked.permanent === true && attempts >= Number(cfg.max_blocked_attempts ?? 8);
  const reasonChanged = task.resource_block_reason !== blocked.reason;
  await c.query(
    `UPDATE tasks
        SET resource_block_reason = $2,
            resource_evaluated_at = app_now(),
            blocked_attempts = $3,
            resource_retry_after = app_now() + make_interval(secs => $4),
            unschedulable = $5,
            version = version + 1,
            updated_at = app_now()
      WHERE task_id = $1`,
    [task.task_id, blocked.reason, attempts, delay, unschedulable]
  );
  if (reasonChanged || unschedulable) {
    await appendEvent(c, {
      task_id: task.task_id,
      event_type: unschedulable ? "TASK_UNSCHEDULABLE" : "TASK_RESOURCE_BLOCKED",
      from_status: "QUEUED",
      to_status: "QUEUED",
      actor: "scheduler",
      payload: {
        reason: blocked.reason,
        detail: blocked.detail,
        blocked_attempts: attempts,
        retry_after_seconds: delay,
        unschedulable
      },
      trace_id: traceId
    });
  }
}
async function admit(c, ctx, task) {
  const { cfg, inst, host, mode, res, policy } = ctx;
  const typeActive = await countActive(
    c,
    `SELECT count(*)::int AS n
       FROM leases l JOIN tasks t USING (task_id)
      WHERE t.task_type = $1 AND l.released_at IS NULL AND l.expires_at > app_now()`,
    [task.task_type]
  );
  if (typeActive >= cfg.task_type_limit) {
    return {
      reason: "CONCURRENCY_LIMIT",
      detail: { scope: "task_type", limit: cfg.task_type_limit }
    };
  }
  const profile = (await c.query(`SELECT * FROM resource_profiles WHERE profile_id = $1`, [task.resource_profile_id])).rows[0];
  if (!profile) {
    return {
      reason: "INSUFFICIENT_MEMORY",
      detail: { why: "resource profile not found", profile: task.resource_profile_id }
    };
  }
  const needMem = BigInt(profile.memory_bytes);
  const needCpu = Math.max(0, Math.trunc(Number(profile.cpu_millicores ?? 0)));
  if (mode === "dynamic") {
    const pool2 = res?.pool ?? null;
    if (pool2?.reported_at && !pool2.cgroup_available) {
      return {
        reason: "CGROUP_UNAVAILABLE",
        detail: { host: host.host_id, pool_id: pool2.pool_id, driver: pool2.cgroup_driver },
        halt: true
      };
    }
    if (!admissionAllowedByPressure(pool2?.pressure_state ?? "NORMAL")) {
      return {
        reason: "HOST_PRESSURE",
        detail: {
          host: host.host_id,
          pressure_state: pool2?.pressure_state,
          mem_used_bytes: pool2?.mem_used_bytes,
          cpu_used_millicores: pool2?.cpu_used_millicores
        },
        halt: true
      };
    }
    const grant = res?.grant ?? null;
    if (!grant) {
      return {
        reason: "GRANT_PENDING",
        detail: { host: host.host_id, instance: inst.instance_id },
        halt: true
      };
    }
    if (grant.state === "FAILED") {
      return {
        reason: "GRANT_FAILED",
        detail: { host: host.host_id, instance: inst.instance_id, error: grant.last_error },
        halt: true
      };
    }
    if (policy.require_applied_before_start) {
      const applied = Number(grant.applied_generation ?? 0);
      if (grant.state !== "APPLIED" || applied < grant.generation) {
        return {
          reason: "GRANT_PENDING",
          detail: {
            host: host.host_id,
            instance: inst.instance_id,
            generation: grant.generation,
            state: grant.state,
            applied_generation: grant.applied_generation
          },
          halt: true
        };
      }
    }
    const reservedMem = Number(res?.reservedMemBytes ?? 0);
    const reservedCpu = Number(res?.reservedCpuMillicores ?? 0);
    if (Number(grant.memory_bytes) < reservedMem || Number(grant.cpu_millicores) < reservedCpu) {
      return {
        reason: "INSUFFICIENT_MEMORY",
        detail: {
          scope: "instance_overcommitted",
          host: host.host_id,
          instance: inst.instance_id,
          grant_bytes: grant.memory_bytes,
          grant_millicores: grant.cpu_millicores,
          reserved_bytes: reservedMem,
          reserved_millicores: reservedCpu,
          grant_generation: grant.generation
        },
        halt: true
      };
    }
    const budgetMem = Math.min(
      Number(inst.cap_mem_bytes || Number.MAX_SAFE_INTEGER),
      Math.max(Number(grant.memory_bytes), Number(res?.fairShareMemBytes ?? 0))
    );
    const budgetCpu = Math.min(
      Number(inst.cap_cpu_millicores || Number.MAX_SAFE_INTEGER),
      Math.max(Number(grant.cpu_millicores), Number(res?.fairShareCpuMillicores ?? 0))
    );
    const remainingMem = Math.max(0, budgetMem - reservedMem);
    const remainingCpu = Math.max(0, budgetCpu - reservedCpu);
    const needMemNum = Number(needMem);
    if (needMemNum > remainingMem) {
      return {
        reason: "INSUFFICIENT_MEMORY",
        detail: {
          scope: "instance_grant",
          host: host.host_id,
          instance: inst.instance_id,
          grant_bytes: grant.memory_bytes,
          grant_generation: grant.generation,
          grant_state: grant.state,
          reserved_bytes: res?.reservedMemBytes ?? 0,
          remaining_bytes: remainingMem,
          requested_bytes: needMemNum
        },
        permanent: needMemNum > Number(inst.cap_mem_bytes || Number.MAX_SAFE_INTEGER)
      };
    }
    if (needCpu > remainingCpu) {
      return {
        reason: "INSUFFICIENT_CPU",
        detail: {
          scope: "instance_grant",
          host: host.host_id,
          instance: inst.instance_id,
          grant_millicores: grant.cpu_millicores,
          grant_generation: grant.generation,
          reserved_millicores: res?.reservedCpuMillicores ?? 0,
          remaining_millicores: remainingCpu,
          requested_millicores: needCpu
        },
        permanent: needCpu > Number(inst.cap_cpu_millicores || Number.MAX_SAFE_INTEGER)
      };
    }
    const kMax = Math.max(1, Number(cfg.task_type_instance_limit ?? 4));
    const typeOnInstance = await countActive(
      c,
      `SELECT count(*)::int AS n
         FROM leases l JOIN tasks t USING (task_id)
        WHERE l.instance_id = $1 AND t.task_type = $2
          AND l.released_at IS NULL AND l.expires_at > app_now()`,
      [inst.instance_id, task.task_type]
    );
    if (typeOnInstance >= kMax) {
      return {
        reason: "CONCURRENCY_LIMIT",
        detail: { scope: "instance_task_type", limit: kMax, active: typeOnInstance }
      };
    }
    const k = computeConcurrency({
      remainingCpuMillicores: remainingCpu,
      remainingMemBytes: remainingMem,
      requestCpuMillicores: needCpu,
      requestMemBytes: needMemNum,
      kMax
    });
    if (k < 1) {
      return {
        reason: needMemNum > remainingMem ? "INSUFFICIENT_MEMORY" : "INSUFFICIENT_CPU",
        detail: {
          scope: "instance_grant",
          k,
          grant_generation: grant.generation,
          remaining_millicores: remainingCpu,
          remaining_bytes: remainingMem
        }
      };
    }
    return null;
  }
  const used = (await c.query(
    `SELECT COALESCE(SUM(memory_bytes),0)::bigint AS mem,
              COALESCE(SUM(cpu_millicores),0)::bigint AS cpu
         FROM resource_reservations
        WHERE host_id = $1 AND state IN ('HELD','ACTIVE')`,
    [host.host_id]
  )).rows[0];
  const usedMem = BigInt(used.mem);
  if (usedMem + needMem > BigInt(host.mem_available_bytes)) {
    return {
      reason: "INSUFFICIENT_MEMORY",
      detail: {
        host: host.host_id,
        available_bytes: host.mem_available_bytes.toString(),
        reserved_bytes: usedMem.toString(),
        requested_bytes: needMem.toString()
      },
      permanent: needMem > BigInt(host.mem_available_bytes)
    };
  }
  return null;
}
async function assign(c, cfg, inst, host, task, traceId, mode, grant) {
  const attemptNumber = Number(
    (await c.query(
      `SELECT COALESCE(MAX(attempt_number), 0) + 1 AS n
           FROM task_attempts WHERE task_id = $1`,
      [task.task_id]
    )).rows[0].n
  );
  const attemptId = newId("att");
  const leaseToken = newToken();
  const grantId = newId("rgr");
  const fencing = Number(
    (await c.query(
      `SELECT COALESCE(MAX(fencing_token), 0) + 1 AS f FROM leases WHERE task_id = $1`,
      [task.task_id]
    )).rows[0].f
  );
  const profile = (await c.query(`SELECT * FROM resource_profiles WHERE profile_id = $1`, [task.resource_profile_id])).rows[0];
  await c.query(
    `INSERT INTO task_attempts (attempt_id, task_id, attempt_number, instance_id, host_id,
                                agent_profile_id, status)
     VALUES ($1,$2,$3,$4,$5,$6,'CREATED')`,
    [attemptId, task.task_id, attemptNumber, inst.instance_id, host.host_id, inst.agent_profile_id]
  );
  const lease = (await c.query(
    `INSERT INTO leases (lease_token, task_id, attempt_id, instance_id, fencing_token, issued_at, expires_at)
       VALUES ($1,$2,$3,$4,$5, app_now(), app_now() + make_interval(secs => $6))
       RETURNING lease_token, expires_at`,
    [leaseToken, task.task_id, attemptId, inst.instance_id, fencing, cfg.lease_seconds]
  )).rows[0];
  await c.query(
    `INSERT INTO resource_reservations
       (grant_id, host_id, instance_id, task_id, attempt_id, profile_id, kind, state,
        cpu_millicores, memory_bytes, disk_bytes)
     VALUES ($1,$2,$3,$4,$5,$6,'TASK','HELD',$7,$8,$9)`,
    [
      grantId,
      host.host_id,
      inst.instance_id,
      task.task_id,
      attemptId,
      profile.profile_id,
      profile.cpu_millicores,
      profile.memory_bytes,
      profile.disk_bytes
    ]
  );
  const updated = await c.query(
    `UPDATE tasks
        SET status = 'ASSIGNED',
            attempt_count = attempt_count + 1,
            current_attempt_id = $2,
            resource_block_reason = NULL,
            resource_evaluated_at = NULL,
            resource_retry_after = NULL,
            blocked_attempts = 0,
            unschedulable = FALSE,
            version = version + 1,
            updated_at = app_now()
      WHERE task_id = $1
      RETURNING *`,
    [task.task_id, attemptId]
  );
  if (Number(task.effective_priority ?? 0) < Number(task.priority_class ?? 0)) {
    await appendEvent(c, {
      task_id: task.task_id,
      event_type: "TASK_AGED",
      from_status: "QUEUED",
      to_status: "QUEUED",
      actor: "scheduler",
      payload: {
        priority_class: task.priority_class,
        effective_priority: task.effective_priority,
        waited_seconds: task.waited_seconds
      },
      trace_id: traceId
    });
  }
  await appendEvent(c, {
    task_id: task.task_id,
    event_type: "TASK_ASSIGNED",
    from_status: "QUEUED",
    to_status: "ASSIGNED",
    actor: inst.instance_id,
    payload: {
      attempt_id: attemptId,
      attempt_number: attemptNumber,
      fencing_token: fencing,
      host_id: host.host_id,
      grant_id: grantId,
      capability_score: Number(inst.capability_score ?? 0),
      scheduling_mode: mode,
      grant_generation: grant?.generation ?? null,
      difficulty: Number(task.difficulty ?? 0)
    },
    trace_id: traceId
  });
  const t = updated.rows[0];
  return {
    task_id: t.task_id,
    task_type: t.task_type,
    attempt_id: attemptId,
    attempt_number: attemptNumber,
    lease_token: lease.lease_token,
    fencing_token: fencing,
    lease_expires_at: lease.expires_at,
    grant_id: grantId,
    payload_ref: t.payload_ref,
    payload_schema: t.payload_schema,
    resource_profile_id: t.resource_profile_id,
    deadline_at: t.deadline_at,
    difficulty: Number(t.difficulty ?? 0),
    requirements: t.requirements ?? {},
    approval_mode: t.approval_mode ?? null,
    // P4: send only references, never implementations, API addresses or secrets; the instance validates against its locally loaded Profile
    agent: {
      profile_id: inst.agent_profile_id ?? null,
      version: inst.agent_profile_version ?? null
    },
    api_profiles: inst.api_profile_ids ?? [],
    started: false,
    scheduling_mode: mode,
    resource_grant: grant ? {
      generation: grant.generation,
      state: grant.state,
      cpu_millicores: grant.cpu_millicores,
      memory_bytes: grant.memory_bytes,
      memory_low_bytes: grant.memory_low_bytes,
      memory_high_bytes: grant.memory_high_bytes,
      cpu_weight: grant.cpu_weight
    } : null
  };
}

// scheduler/src/statemachine.ts
var TRANSITIONS = {
  QUEUED: {
    ASSIGNED: "claim",
    RUNNING: "relay_started",
    SUCCEEDED: "relay_result_succeeded",
    FAILED: "relay_result_failed_retry_exhausted",
    BLOCKED: "external_dependency_unavailable",
    CANCELLED: "operator_cancel"
  },
  ASSIGNED: {
    RUNNING: "start_ack",
    QUEUED: "start_timeout | lease_expired | admission_rejected",
    SUCCEEDED: "relay_result_succeeded",
    FAILED: "relay_result_failed_retry_exhausted",
    CANCELLED: "cancel_ack | forced_cancel"
  },
  RUNNING: {
    SUCCEEDED: "result_succeeded",
    FAILED: "result_failed_retry_exhausted",
    QUEUED: "result_failed_retryable | lease_expired",
    BLOCKED: "external_dependency_unavailable",
    CANCELLED: "cancel_ack | forced_cancel",
    NEEDS_INPUT: "agent_needs_input",
    WAITING_CHILDREN: "agent_split"
  },
  // Parking is not a failure: both waiting states leave QUEUED or FAILED (expired / children
  // exhausted) as the only forward edges, plus cancellation.
  NEEDS_INPUT: {
    QUEUED: "answered",
    FAILED: "input_expired",
    CANCELLED: "operator_cancel"
  },
  WAITING_CHILDREN: {
    QUEUED: "children_settled",
    FAILED: "children_exhausted",
    CANCELLED: "operator_cancel"
  },
  BLOCKED: {
    QUEUED: "dependency_recovered",
    CANCELLED: "operator_cancel"
  },
  SUCCEEDED: {},
  FAILED: {},
  CANCELLED: {}
};
var APPROVAL_MODES = ["ask", "edits", "auto", "full"];
var TERMINAL = ["SUCCEEDED", "FAILED", "CANCELLED"];
function isTerminal(s) {
  return TERMINAL.includes(s);
}
function assertTransition(from, to, cause) {
  if (from === to) return;
  if (!TRANSITIONS[from]?.[to]) {
    throw new ApiError(
      409,
      "STATE_CONFLICT",
      `illegal state transition ${from} \u2192 ${to}${cause ? ` (cause: ${cause})` : ""}`,
      { from, to, allowed: Object.keys(TRANSITIONS[from] ?? {}) }
    );
  }
}

// scheduler/src/node.ts
function selfNodeId() {
  return config.nodeId || `${config.hostId || "scheduler"}:root`;
}

// scheduler/src/core/relay.ts
function recordOf(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
var MAX_RELAY_DEPTH = 8;
var RELAY_FETCH_TIMEOUT_MS = 8e3;
var RELAY_NODE_FRESH_SECONDS = Math.max(
  90,
  Math.ceil(config.federationIntervalMs / 1e3) * 3
);
function logRelay(message, extra) {
  if (extra === void 0) console.warn(`[relay] ${message}`);
  else console.warn(`[relay] ${message}`, extra);
}
async function maybeRelayTask(task, input) {
  if (!config.federationToken) return null;
  const depth = Number(input.relay?.depth ?? task.relay_depth ?? 0);
  if (depth >= MAX_RELAY_DEPTH) return null;
  if (task.workflow_run_id || task.parent_task_id) return null;
  const relayed = await q1(`SELECT 1 AS ok FROM task_relays WHERE parent_task_id = $1`, [
    task.task_id
  ]);
  if (relayed) return null;
  const def = await q1(
    `SELECT target_role FROM task_definitions WHERE task_type = $1`,
    [task.task_type]
  );
  if (def?.target_role !== "builder") return null;
  const requirements = task.requirements ?? {};
  const targetInstance = String(requirements.target_instance_id ?? "").trim();
  const node = targetInstance ? await relayNodeForInstance(targetInstance) : await relayNodeForCapacity(task.task_type, task.difficulty, task.task_id);
  if (!node?.url) return null;
  try {
    return await relayToNode(node, task, input, depth);
  } catch (e) {
    logRelay(`Push-down failed ${task.task_id} \u2192 ${node.node_id}`, e instanceof Error ? e.message : e);
    return null;
  }
}
async function relayNodeForInstance(instanceId) {
  const local = await q1(`SELECT 1 AS ok FROM role_instances WHERE instance_id = $1 LIMIT 1`, [
    instanceId
  ]);
  if (local) return null;
  return q1(
    `SELECT node_id, url, max_builder_score, idle_builder_count,
            mode, max_builder_ceiling, max_builder_live, pressure_state
       FROM scheduler_nodes
      WHERE parent_node_id = $1
        AND url IS NOT NULL AND url <> ''
        AND updated_at > app_now() - make_interval(secs => $2)
        AND instances @> $3::jsonb
      ORDER BY CASE WHEN pressure_state IN ('NORMAL','BUSY','RECOVERING') THEN 0 ELSE 1 END,
               node_id
      LIMIT 1`,
    [selfNodeId(), RELAY_NODE_FRESH_SECONDS, JSON.stringify([{ instance_id: instanceId }])]
  );
}
async function relayNodeForCapacity(taskType, difficulty, parentTaskId) {
  const d = Number(difficulty) || 0;
  const local = await q1(
    `SELECT count(*)::int AS n
       FROM role_instances r
      WHERE r.role_id = 'builder'
        AND r.state = 'ONLINE'
        AND $1 = ANY(r.allowed_task_types)
        AND $2 = ANY(r.payload_schemas)
        -- Same-mode local routing compares W_live; static rows have live = frozen W.
        AND (
          $3 <= 0
          OR (CASE WHEN r.scheduling_mode = 'dynamic'
                   THEN GREATEST(r.capability_dispatch_score, r.capability_live_score, 0)
                   ELSE r.capability_score END) >= $3
        )`,
    [taskType, "1.0", d]
  );
  if (Number(local?.n ?? 0) > 0) return null;
  const relayed = await q1(`SELECT 1 AS ok FROM task_relays WHERE parent_task_id = $1`, [
    parentTaskId
  ]);
  if (relayed) return null;
  const sameMode = config.schedulingMode;
  const order = d > 0 ? `(mode = $4) DESC,
         (pressure_state IN ('NORMAL','BUSY','RECOVERING')) DESC,
         CASE WHEN mode = $4 THEN max_builder_live ELSE max_builder_ceiling END ASC,
         idle_builder_count DESC, node_id` : `(mode = $4) DESC,
         (pressure_state IN ('NORMAL','BUSY','RECOVERING')) DESC,
         idle_builder_count DESC,
         CASE WHEN mode = $4 THEN max_builder_live ELSE max_builder_ceiling END DESC,
         node_id`;
  return q1(
    `SELECT node_id, url, max_builder_score, idle_builder_count,
            mode, max_builder_ceiling, max_builder_live, pressure_state
       FROM scheduler_nodes
      WHERE parent_node_id = $1
        AND url IS NOT NULL AND url <> ''
        AND builder_count > 0
        AND updated_at > app_now() - make_interval(secs => $2)
        AND ($3 <= 0 OR max_builder_ceiling >= $3)
      ORDER BY ${order}
      LIMIT 1`,
    [selfNodeId(), RELAY_NODE_FRESH_SECONDS, d, sameMode]
  );
}
async function relayToNode(node, task, input, depth) {
  const body = {
    task_type: input.task_type,
    priority_class: input.priority_class,
    payload_ref: input.payload_ref,
    payload_sha256: input.payload_sha256,
    payload_schema: input.payload_schema,
    requirements: input.requirements,
    resource_profile_id: input.resource_profile_id,
    difficulty: input.difficulty,
    max_attempts: input.max_attempts,
    deadline_at: input.deadline_at,
    trace_id: input.trace_id,
    relay: {
      parent_task_id: task.task_id,
      parent_node_id: selfNodeId(),
      depth: depth + 1
    }
  };
  const res = await fetch(`${node.url.replace(/\/+$/, "")}/v1/tasks`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-federation-token": config.federationToken
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(RELAY_FETCH_TIMEOUT_MS)
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`child node returned ${res.status}: ${text.slice(0, 200)}`);
  }
  let out = null;
  try {
    out = JSON.parse(text);
  } catch {
    throw new Error("child node did not return JSON");
  }
  const childTaskId = String(recordOf(out)?.task_id ?? "").trim();
  if (!childTaskId) throw new Error("child node did not return task_id");
  await tx(async (c) => {
    const inserted = await c.query(
      `INSERT INTO task_relays
         (parent_task_id, child_node_id, child_url, child_task_id, state)
       VALUES ($1,$2,$3,$4,'ACTIVE')
       ON CONFLICT (parent_task_id) DO NOTHING
       RETURNING *`,
      [task.task_id, node.node_id, node.url.replace(/\/+$/, ""), childTaskId]
    );
    if (!inserted.rows[0]) return;
    await appendEvent(c, {
      task_id: task.task_id,
      event_type: "TASK_RELAYED",
      to_status: "QUEUED",
      actor: selfNodeId(),
      payload: {
        child_node_id: node.node_id,
        child_task_id: childTaskId,
        child_url: node.url,
        depth: depth + 1
      }
    });
  });
  return { node_id: node.node_id, child_task_id: childTaskId };
}
function latestAttempt(child) {
  const attempts = Array.isArray(recordOf(child)?.attempts) ? recordOf(child).attempts : [];
  return attempts.length ? recordOf(attempts[attempts.length - 1]) ?? null : null;
}
function childSummary(child) {
  const attempt = latestAttempt(child);
  return String(recordOf(child)?.result_summary ?? attempt?.result_summary ?? "");
}
function childOutputs(child) {
  const attempt = latestAttempt(child);
  const relay = recordOf(recordOf(child)?.relay);
  const childResult = recordOf(relay?.child_result);
  const raw = attempt?.outputs ?? childResult?.outputs;
  return recordOf(raw) ?? {};
}
async function mirrorStatus(parentTaskId, target, childStatus, summary) {
  if (!["QUEUED", "ASSIGNED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"].includes(target)) {
    return false;
  }
  return tx(async (c) => {
    const row = (await c.query(`SELECT * FROM tasks WHERE task_id = $1 FOR UPDATE`, [parentTaskId])).rows[0];
    if (!row) return false;
    const from = row.status;
    if (isTerminal(from) || from === target) return false;
    assertTransition(from, target, "relay_sync");
    await c.query(
      `UPDATE tasks
          SET status = $2,
              result_summary = CASE WHEN $3 <> '' THEN $3 ELSE result_summary END,
              version = version + 1,
              updated_at = app_now()
        WHERE task_id = $1`,
      [parentTaskId, target, summary]
    );
    await appendEvent(c, {
      task_id: parentTaskId,
      event_type: `TASK_RELAY_${target}`,
      from_status: from,
      to_status: target,
      actor: "relay",
      payload: { child_status: childStatus, summary: summary || null }
    });
    return true;
  });
}
async function markRelay(parentTaskId, state, childState, childResult) {
  await q(
    `UPDATE task_relays
        SET state = $2,
            child_state = COALESCE($3, child_state),
            child_result = COALESCE($4::jsonb, child_result),
            updated_at = app_now()
      WHERE parent_task_id = $1`,
    [
      parentTaskId,
      state,
      childState ?? null,
      childResult === void 0 ? null : JSON.stringify(childResult)
    ]
  );
}
async function recordRelayFailure(parentTaskId, message) {
  await q(
    `UPDATE task_relays
        SET sync_failures = sync_failures + 1,
            last_error = $2,
            updated_at = app_now()
      WHERE parent_task_id = $1`,
    [parentTaskId, message.slice(0, 500)]
  );
}
async function sendChildCancel(row) {
  try {
    const res = await fetch(
      `${row.child_url.replace(/\/+$/, "")}/v1/tasks/${encodeURIComponent(row.child_task_id)}/cancel`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actor: "relay:operator" }),
        signal: AbortSignal.timeout(RELAY_FETCH_TIMEOUT_MS)
      }
    );
    if (!res.ok && res.status !== 409) {
      throw new Error(`child node cancel returned ${res.status}`);
    }
    await q(
      `UPDATE task_relays SET cancel_sent = TRUE, updated_at = app_now()
        WHERE parent_task_id = $1`,
      [row.parent_task_id]
    );
  } catch (e) {
    await recordRelayFailure(
      row.parent_task_id,
      `failed to forward cancellation: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}
async function requestRelayCancel(parentTaskId) {
  const row = await q1(
    `SELECT r.*, t.status AS parent_status, t.cancel_requested_at
       FROM task_relays r JOIN tasks t ON t.task_id = r.parent_task_id
      WHERE r.parent_task_id = $1 AND r.state = 'ACTIVE'`,
    [parentTaskId]
  );
  if (row && !row.cancel_sent) await sendChildCancel(row);
}
async function syncRelays(limit = 50) {
  const rows = await q(
    `SELECT r.parent_task_id, r.child_node_id, r.child_url, r.child_task_id, r.state,
            r.cancel_sent, r.sync_failures,
            t.status AS parent_status, t.cancel_requested_at
       FROM task_relays r
       JOIN tasks t ON t.task_id = r.parent_task_id
      WHERE r.state = 'ACTIVE'
      ORDER BY r.updated_at
      LIMIT $1`,
    [limit]
  );
  let updated = 0;
  for (const row of rows) {
    if (isTerminal(row.parent_status)) {
      await markRelay(
        row.parent_task_id,
        row.parent_status === "CANCELLED" ? "CANCELLED" : "DONE"
      );
      continue;
    }
    if (row.cancel_requested_at && !row.cancel_sent) {
      await sendChildCancel(row);
    }
    let child;
    try {
      const res = await fetch(
        `${row.child_url.replace(/\/+$/, "")}/v1/tasks/${encodeURIComponent(row.child_task_id)}`,
        { signal: AbortSignal.timeout(RELAY_FETCH_TIMEOUT_MS) }
      );
      if (!res.ok) throw new Error(`child node returned ${res.status}`);
      child = await res.json();
    } catch (e) {
      await recordRelayFailure(
        row.parent_task_id,
        e instanceof Error ? e.message : String(e)
      );
      continue;
    }
    const childStatus = String(recordOf(child)?.status ?? "").toUpperCase();
    const summary = childSummary(child);
    if (!childStatus) {
      await recordRelayFailure(row.parent_task_id, "child task is missing status");
      continue;
    }
    if (childStatus === "SUCCEEDED" || childStatus === "FAILED" || childStatus === "CANCELLED") {
      const terminal = childStatus;
      const changed = await mirrorStatus(row.parent_task_id, terminal, childStatus, summary);
      if (changed) updated++;
      await markRelay(
        row.parent_task_id,
        terminal === "CANCELLED" ? "CANCELLED" : "DONE",
        childStatus,
        { summary, outputs: childOutputs(child) }
      );
      continue;
    }
    if (childStatus === "ASSIGNED" || childStatus === "RUNNING" || childStatus === "QUEUED") {
      if (await mirrorStatus(row.parent_task_id, childStatus, childStatus, summary)) {
        updated++;
      }
    }
  }
  return { checked: rows.length, updated };
}

// scheduler/src/core/lease.ts
async function closeActiveLease(c, taskId, reason, reservationState = "RELEASED") {
  const lease = (await c.query(
    `UPDATE leases SET released_at = app_now(), release_reason = $2
        WHERE task_id = $1 AND released_at IS NULL
        RETURNING attempt_id`,
    [taskId, reason]
  )).rows[0];
  if (!lease) return;
  await c.query(
    `UPDATE resource_reservations
        SET state = $3, closed_at = app_now(), close_reason = $2
      WHERE attempt_id = $1 AND state IN ('HELD','ACTIVE')`,
    [lease.attempt_id, reason, reservationState]
  );
}

// scheduler/src/repo/task-insert.ts
async function insertTask(c, input) {
  if (!input.task_type) throw new ApiError(400, "BAD_REQUEST", "task_type is required");
  const def = await c.query(`SELECT * FROM task_definitions WHERE task_type = $1`, [
    input.task_type
  ]);
  const d = def.rows[0];
  if (!d) throw new ApiError(422, "TASK_TYPE_UNKNOWN", `unknown task type: ${input.task_type}`);
  const profile = input.resource_profile_id ?? d.default_profile;
  if (!profile) throw new ApiError(422, "PROFILE_UNKNOWN", "missing resource profile");
  const taskId = newId("task");
  const priority = input.priority_class ?? 1;
  const difficulty = normalizeDifficulty(input.difficulty);
  const relayParent = input.relay?.parent_task_id?.trim() || null;
  const relayDepth = relayParent ? Math.max(0, Math.min(64, Number(input.relay?.depth) || 0)) : 0;
  if (input.approval_mode && !APPROVAL_MODES.includes(input.approval_mode)) {
    throw new ApiError(
      422,
      "APPROVAL_MODE_INVALID",
      `approval_mode must be one of ${APPROVAL_MODES.join(", ")}`
    );
  }
  const approvalMode = input.approval_mode ?? (await c.query(`SELECT default_approval_mode FROM scheduler_config WHERE id = TRUE`)).rows[0]?.default_approval_mode ?? "full";
  const fanoutDepth = Math.max(0, Math.min(32, Number(input.fanout_depth) || 0));
  if (relayParent) {
    const existing = await c.query(`SELECT * FROM tasks WHERE relay_parent_task_id = $1`, [
      relayParent
    ]);
    if (existing.rows[0]) return existing.rows[0];
  }
  const res = await c.query(
    `INSERT INTO tasks (task_id, task_type, task_version, workflow_run_id, parent_task_id,
                        priority_class, status, payload_ref, payload_sha256, payload_schema,
                        requirements, resource_profile_id, max_attempts, difficulty, enqueued_at,
                        deadline_at, created_at, updated_at, relay_parent_task_id, relay_depth,
                        approval_mode, fanout_id, fanout_depth)
     VALUES ($1,$2,$3,$4,$5,$6,'QUEUED',$7,$8,$9,$10,$11,$12,$13, app_now(), $14, app_now(), app_now(), $15, $16, $17, $18, $19)
     ON CONFLICT (relay_parent_task_id) WHERE relay_parent_task_id IS NOT NULL DO NOTHING
     RETURNING *`,
    [
      taskId,
      input.task_type,
      d.task_version,
      input.workflow_run_id ?? null,
      input.parent_task_id ?? null,
      priority,
      input.payload_ref ?? null,
      input.payload_sha256 ?? null,
      input.payload_schema ?? "1.0",
      JSON.stringify(input.requirements ?? {}),
      profile,
      input.max_attempts ?? d.max_attempts ?? 3,
      difficulty,
      input.deadline_at ? new Date(input.deadline_at) : null,
      relayParent,
      relayDepth,
      approvalMode,
      input.fanout_id ?? null,
      fanoutDepth
    ]
  );
  if (!res.rows[0]) {
    const existing = await c.query(`SELECT * FROM tasks WHERE relay_parent_task_id = $1`, [
      relayParent
    ]);
    return existing.rows[0];
  }
  await appendEvent(c, {
    task_id: taskId,
    event_type: "TASK_CREATED",
    to_status: "QUEUED",
    actor: relayParent ? "relay" : "api",
    payload: {
      task_type: input.task_type,
      priority_class: priority,
      difficulty,
      approval_mode: approvalMode,
      ...relayParent ? { relay_parent_task_id: relayParent, parent_node_id: input.relay?.parent_node_id ?? null } : {}
    },
    trace_id: input.trace_id
  });
  return res.rows[0];
}

// scheduler/src/core/workflow.ts
function sanitizeRequirements(raw) {
  const req = { ...raw ?? {} };
  delete req.upstream_artifacts;
  delete req.upstream_artifact_id;
  delete req.upstream_sha256;
  delete req.approval_id;
  delete req.approval_subject_digest;
  delete req.approved_action_scope;
  return req;
}
var PHASE_STATUS = {
  EXECUTE: "RUNNING",
  REVIEW: "WAITING_REVIEW",
  APPROVE: "WAITING_APPROVAL",
  COMMIT: "READY_FOR_COMMIT",
  VERIFY: "VERIFYING",
  DELIVER: "RUNNING"
};
async function loadTemplate(c, templateId) {
  const row = (await c.query(`SELECT * FROM workflow_templates WHERE workflow_template_id = $1`, [templateId])).rows[0];
  if (!row) {
    throw new ApiError(404, "WORKFLOW_TEMPLATE_UNKNOWN", `workflow template not found: ${templateId}`);
  }
  const phases = row.phases;
  if (!Array.isArray(phases) || phases.length === 0) {
    throw new ApiError(422, "WORKFLOW_TEMPLATE_INVALID", "template has no phases");
  }
  return { ...row, phases };
}
async function appendWorkflowEvent(c, runId, eventType, payload) {
  await c.query(
    `INSERT INTO outbox_events
       (event_type, schema_version, aggregate_type, aggregate_id, payload)
     VALUES ($1, '1.0', 'workflow', $2, $3)`,
    [eventType, runId, JSON.stringify({ workflow_run_id: runId, ...payload })]
  );
}
async function createWorkflowRun(input) {
  if (!input.workflow_template_id) {
    throw new ApiError(400, "BAD_REQUEST", "workflow_template_id is required");
  }
  return tx(async (c) => {
    const tpl = await loadTemplate(c, input.workflow_template_id);
    const first = tpl.phases[0];
    if (!first.task_type) {
      throw new ApiError(422, "WORKFLOW_TEMPLATE_INVALID", "the first phase must have a task_type");
    }
    const runId = newId("wfr");
    const context = {
      priority_class: input.priority_class ?? 1,
      payload_ref: input.payload_ref ?? null,
      payload_sha256: input.payload_sha256 ?? null,
      payload_schema: input.payload_schema ?? "1.0",
      requirements: sanitizeRequirements(input.requirements),
      deadline_at: input.deadline_at ?? null
    };
    await c.query(
      `INSERT INTO workflow_runs
         (workflow_run_id, workflow_template_id, template_version, status, context)
       VALUES ($1,$2,$3,'PENDING',$4)`,
      [runId, tpl.workflow_template_id, tpl.version, JSON.stringify(context)]
    );
    const task = await insertTask(c, {
      task_type: first.task_type,
      workflow_run_id: runId,
      priority_class: context.priority_class,
      payload_ref: context.payload_ref ?? void 0,
      payload_sha256: context.payload_sha256 ?? void 0,
      payload_schema: context.payload_schema,
      requirements: context.requirements,
      deadline_at: context.deadline_at ?? void 0,
      trace_id: input.trace_id
    });
    const run = (await c.query(
      `UPDATE workflow_runs
            SET status = $2, current_phase = $3, root_task_id = $4, current_task_id = $4,
                updated_at = app_now()
          WHERE workflow_run_id = $1
          RETURNING *`,
      [runId, PHASE_STATUS[first.phase] ?? "RUNNING", first.phase, task.task_id]
    )).rows[0];
    await appendWorkflowEvent(c, runId, "WORKFLOW_CREATED", {
      phase: first.phase,
      task_id: task.task_id
    });
    return { run, task };
  });
}
async function advanceWorkflow(c, task, outcome) {
  if (!task.workflow_run_id) return;
  const run = (await c.query(
    `SELECT * FROM workflow_runs WHERE workflow_run_id = $1 FOR UPDATE`,
    [task.workflow_run_id]
  )).rows[0];
  if (!run) return;
  if (run.current_task_id && run.current_task_id !== task.task_id) return;
  if (outcome === "CANCELLED") {
    await finishRun(c, run, "CANCELLED", "TASK_CANCELLED");
    return;
  }
  if (outcome === "FAILED") {
    await finishRun(c, run, "FAILED", "WORKFLOW_FAILED");
    return;
  }
  const tpl = await loadTemplate(c, run.workflow_template_id);
  const idx = tpl.phases.findIndex((p) => p.phase === run.current_phase);
  if (idx < 0) {
    throw new ApiError(500, "WORKFLOW_STATE_INVALID", `current phase is not in the template: ${run.current_phase}`);
  }
  const next = tpl.phases[idx + 1];
  if (!next) {
    await finishRun(c, run, "COMPLETED", "WORKFLOW_COMPLETED");
    return;
  }
  if (next.phase === "APPROVE") {
    await enterApproval(c, run, task, tpl, next);
    return;
  }
  const nextTask = await insertNextTask(c, run, task, next);
  await c.query(
    `UPDATE workflow_runs
        SET status = $2, current_phase = $3, current_task_id = $4, updated_at = app_now()
      WHERE workflow_run_id = $1`,
    [run.workflow_run_id, PHASE_STATUS[next.phase] ?? "RUNNING", next.phase, nextTask.task_id]
  );
  await appendWorkflowEvent(c, run.workflow_run_id, "WORKFLOW_PHASE_STARTED", {
    phase: next.phase,
    task_id: nextTask.task_id,
    parent_task_id: task.task_id
  });
}
async function finishRun(c, run, status, eventType) {
  await c.query(
    `UPDATE workflow_runs
        SET status = $2, current_task_id = NULL, updated_at = app_now()
      WHERE workflow_run_id = $1`,
    [run.workflow_run_id, status]
  );
  await appendWorkflowEvent(c, run.workflow_run_id, eventType, {
    phase: run.current_phase
  });
}
async function insertNextTask(c, run, prev, phase, extra = {}) {
  const ctx = run.context ?? {};
  const artifacts = (await c.query(
    `SELECT artifact_id, actual_sha256, media_type
         FROM artifacts
        WHERE task_id = $1 AND status = 'COMPLETE'
        ORDER BY completed_at DESC, artifact_id DESC`,
    [prev.task_id]
  )).rows;
  const prevReq = prev.requirements ?? {};
  const inherited = Array.isArray(prevReq.upstream_artifacts) ? prevReq.upstream_artifacts : [];
  const refs = [
    ...inherited,
    ...artifacts.map((a) => ({
      artifact_id: a.artifact_id,
      sha256: a.actual_sha256,
      media_type: a.media_type,
      task_id: prev.task_id,
      task_type: prev.task_type
    }))
  ].filter((v, i, all) => all.findIndex((x) => x.artifact_id === v.artifact_id) === i).slice(-50);
  const requirements = {
    ...ctx.requirements ?? {},
    ...prevReq,
    ...refs.length ? {
      upstream_artifacts: refs,
      upstream_artifact_id: artifacts[0]?.artifact_id,
      upstream_sha256: artifacts[0]?.actual_sha256
    } : {},
    ...extra
  };
  const input = {
    task_type: phase.task_type,
    workflow_run_id: run.workflow_run_id,
    parent_task_id: prev.task_id,
    priority_class: ctx.priority_class ?? prev.priority_class,
    payload_ref: ctx.payload_ref ?? prev.payload_ref ?? void 0,
    payload_sha256: ctx.payload_sha256 ?? prev.payload_sha256 ?? void 0,
    payload_schema: ctx.payload_schema ?? prev.payload_schema ?? "1.0",
    requirements,
    deadline_at: ctx.deadline_at ?? void 0
  };
  return insertTask(c, input);
}
async function enterApproval(c, run, prev, tpl, phase) {
  const artifact = (await c.query(
    `SELECT actual_sha256 FROM artifacts
        WHERE task_id = $1 AND status = 'COMPLETE'
        ORDER BY completed_at DESC, artifact_id DESC LIMIT 1`,
    [prev.task_id]
  )).rows[0];
  if (phase.artifact_required && !artifact) {
    throw new ApiError(409, "ARTIFACT_REQUIRED", "this approval phase requires an artifact uploaded and verified in the previous phase");
  }
  const attempt = (await c.query(
    `SELECT outputs FROM task_attempts
        WHERE task_id = $1 AND status = 'SUCCEEDED'
        ORDER BY attempt_number DESC LIMIT 1`,
    [prev.task_id]
  )).rows[0];
  const outputs = attempt?.outputs;
  const subjectDigest = artifact?.actual_sha256 ?? (outputs && typeof outputs === "object" && outputs.subject_digest) ?? (outputs && typeof outputs === "object" && outputs.sha256) ?? prev.payload_sha256 ?? null;
  await c.query(
    `UPDATE workflow_runs
        SET status = 'WAITING_APPROVAL', current_phase = $2, updated_at = app_now()
      WHERE workflow_run_id = $1`,
    [run.workflow_run_id, phase.phase]
  );
  await c.query(
    `INSERT INTO approval_requests
       (approval_request_id, workflow_run_id, task_id, status, subject_digest,
        action_scope, policy_version)
     VALUES ($1,$2,$3,'PENDING',$4,$5,$6)`,
    [
      newId("aprq"),
      run.workflow_run_id,
      prev.task_id,
      subjectDigest,
      phase.action_scope ?? [],
      tpl.approval_policy_ref ?? null
    ]
  );
  await appendWorkflowEvent(c, run.workflow_run_id, "WORKFLOW_WAITING_APPROVAL", {
    task_id: prev.task_id,
    subject_digest: subjectDigest
  });
}
async function decideApproval(input) {
  requireApprovalConfigured();
  if (!input.approval_token || !input.operator_id) {
    throw new ApiError(400, "BAD_REQUEST", "approval_token / operator_id are required");
  }
  if (input.decision !== "APPROVED" && input.decision !== "REJECTED") {
    throw new ApiError(400, "BAD_REQUEST", "decision must be APPROVED or REJECTED");
  }
  const claims = verifyApprovalToken(input.approval_token);
  if (claims.operator_id !== input.operator_id) {
    throw new ApiError(403, "ROLE_NOT_ALLOWED", "approval token operator does not match the caller", {
      token_operator: claims.operator_id,
      requested: input.operator_id
    });
  }
  return tx(async (c) => {
    const req = (await c.query(
      `SELECT * FROM approval_requests WHERE task_id = $1 AND status = 'PENDING' FOR UPDATE`,
      [input.task_id]
    )).rows[0];
    if (!req) throw new ApiError(404, "APPROVAL_NOT_FOUND", "no pending approval request");
    if (claims.approval_request_id !== req.approval_request_id) {
      throw new ApiError(403, "ROLE_NOT_ALLOWED", "approval token was not issued for this request", {
        token_request: claims.approval_request_id,
        pending_request: req.approval_request_id
      });
    }
    const tokenDigest = claims.subject_digest ?? null;
    if (req.subject_digest && tokenDigest !== req.subject_digest) {
      throw new ApiError(409, "APPROVAL_SUBJECT_CHANGED", "the approval subject has changed; approval must be repeated", {
        expected: req.subject_digest,
        got: tokenDigest
      });
    }
    if (input.subject_digest && input.subject_digest !== tokenDigest) {
      throw new ApiError(409, "APPROVAL_SUBJECT_CHANGED", "request body digest does not match the approval token", {
        token: tokenDigest,
        body: input.subject_digest
      });
    }
    const reqScope = [...req.action_scope ?? []].sort();
    const tokenScope = [...claims.action_scope].sort();
    if (reqScope.join(",") !== tokenScope.join(",")) {
      throw new ApiError(403, "ROLE_NOT_ALLOWED", "approval token action scope does not match the request", {
        expected: reqScope,
        got: tokenScope
      });
    }
    const run = (await c.query(`SELECT * FROM workflow_runs WHERE workflow_run_id = $1 FOR UPDATE`, [
      req.workflow_run_id
    ])).rows[0];
    if (!run) throw new ApiError(409, "STATE_CONFLICT", "the workflow for this approval does not exist");
    if (claims.jti) {
      const used = await q1(`SELECT 1 FROM approvals WHERE token_jti = $1`, [claims.jti]);
      if (used) throw new ApiError(409, "APPROVAL_TOKEN_USED", "approval token has already been used");
    }
    const approval = (await c.query(
      `INSERT INTO approvals
           (approval_id, task_id, workflow_run_id, decision, operator_id, comment,
            approval_token, token_jti, subject_digest, action_scope, policy_version, decided_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, app_now())
         RETURNING *`,
      [
        newId("apr"),
        req.task_id,
        req.workflow_run_id,
        input.decision,
        input.operator_id,
        input.comment ?? null,
        input.approval_token,
        claims.jti ?? null,
        tokenDigest,
        req.action_scope ?? [],
        input.policy_version ?? req.policy_version
      ]
    )).rows[0];
    await c.query(
      `UPDATE approval_requests SET status = $2, decided_at = app_now()
        WHERE approval_request_id = $1`,
      [req.approval_request_id, input.decision]
    );
    await appendWorkflowEvent(c, run.workflow_run_id, "APPROVAL_DECIDED", {
      task_id: req.task_id,
      decision: input.decision,
      operator_id: input.operator_id,
      approval_id: approval.approval_id,
      subject_digest: approval.subject_digest
    });
    if (input.decision === "REJECTED") {
      await finishRun(c, run, "FAILED", "WORKFLOW_FAILED");
      return { run: { ...run, status: "FAILED" }, approval, task: null };
    }
    const tpl = await loadTemplate(c, run.workflow_template_id);
    const idx = tpl.phases.findIndex((p) => p.phase === run.current_phase);
    const next = idx >= 0 ? tpl.phases[idx + 1] : void 0;
    if (!next) {
      await finishRun(c, run, "COMPLETED", "WORKFLOW_COMPLETED");
      return { run: { ...run, status: "COMPLETED" }, approval, task: null };
    }
    const prevTask = (await c.query(`SELECT * FROM tasks WHERE task_id = $1`, [req.task_id])).rows[0];
    const nextTask = await insertNextTask(c, run, prevTask, next, {
      approval_id: approval.approval_id,
      approval_subject_digest: approval.subject_digest,
      approved_action_scope: approval.action_scope ?? []
    });
    const updatedRun = (await c.query(
      `UPDATE workflow_runs
            SET status = $2, current_phase = $3, current_task_id = $4, updated_at = app_now()
          WHERE workflow_run_id = $1
          RETURNING *`,
      [run.workflow_run_id, PHASE_STATUS[next.phase] ?? "RUNNING", next.phase, nextTask.task_id]
    )).rows[0];
    await appendWorkflowEvent(c, run.workflow_run_id, "WORKFLOW_PHASE_STARTED", {
      phase: next.phase,
      task_id: nextTask.task_id,
      parent_task_id: req.task_id,
      after_approval: true
    });
    return { run: updatedRun, approval, task: nextTask };
  });
}
async function getWorkflowRun(runId) {
  const run = await q1(`SELECT * FROM workflow_runs WHERE workflow_run_id = $1`, [runId]);
  if (!run) throw new ApiError(404, "NOT_FOUND", `workflow not found: ${runId}`);
  const tasks = await q(
    `SELECT task_id, task_type, status, parent_task_id, current_attempt_id,
            attempt_count, enqueued_at, updated_at
       FROM tasks WHERE workflow_run_id = $1 ORDER BY enqueued_at, task_id`,
    [runId]
  );
  const approvals = await q(
    `SELECT approval_request_id, task_id, status, subject_digest, action_scope,
            policy_version, requested_at, decided_at
       FROM approval_requests WHERE workflow_run_id = $1 ORDER BY requested_at`,
    [runId]
  );
  return { ...run, tasks, approval_requests: approvals };
}
async function listApprovalRequests(filter = {}) {
  const status = filter.status ?? null;
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
  return q(
    `SELECT ar.approval_request_id, ar.workflow_run_id, ar.task_id, ar.status,
            ar.subject_digest, ar.action_scope, ar.policy_version,
            ar.requested_at, ar.decided_at,
            t.task_type, t.status AS task_status, t.payload_ref,
            t.payload_sha256, td.target_role,
            wr.status AS workflow_status, wr.current_phase,
            ap.approval_id, ap.decision, ap.operator_id AS decided_by,
            ap.comment AS decision_comment, ap.decided_at AS decision_at,
            ev.evidence
       FROM approval_requests ar
       JOIN tasks t ON t.task_id = ar.task_id
       JOIN task_definitions td ON td.task_type = t.task_type
       JOIN workflow_runs wr ON wr.workflow_run_id = ar.workflow_run_id
       LEFT JOIN LATERAL (
         SELECT approval_id, decision, operator_id, comment, decided_at
           FROM approvals
          WHERE task_id = ar.task_id AND workflow_run_id = ar.workflow_run_id
          ORDER BY decided_at DESC LIMIT 1
       ) ap ON TRUE
       LEFT JOIN LATERAL (
         SELECT array_agg(media_type || ':' || COALESCE(actual_sha256, 'pending')) AS evidence
           FROM artifacts
          WHERE task_id = ar.task_id AND status = 'COMPLETE'
       ) ev ON TRUE
      WHERE ($1::text IS NULL OR ar.status = $1)
      ORDER BY ar.requested_at DESC
      LIMIT $2`,
    [status, limit]
  );
}
async function listWorkflowRuns(limit = 100) {
  return q(
    `SELECT workflow_run_id, workflow_template_id, template_version, status,
            current_phase, root_task_id, current_task_id, created_at, updated_at
       FROM workflow_runs ORDER BY created_at DESC, workflow_run_id
       LIMIT $1`,
    [Math.min(Math.max(limit, 1), 500)]
  );
}

// scheduler/src/core/fanout.ts
function isObject(v) {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}
async function loadConfig2(c) {
  const row = (await c.query(`SELECT * FROM scheduler_config WHERE id = TRUE`)).rows[0] ?? {};
  return {
    max_fanout_children: Number(row.max_fanout_children) || 16,
    max_fanout_depth: Number(row.max_fanout_depth) || 4,
    max_resume_rounds: Number(row.max_resume_rounds) || 8
  };
}
async function splitTask(taskId, proof2, children) {
  if (!Array.isArray(children) || children.length === 0) {
    throw new ApiError(422, "SPLIT_INVALID", "split requires at least one child");
  }
  return tx(async (c) => {
    const cfg = await loadConfig2(c);
    if (children.length > cfg.max_fanout_children) {
      throw new ApiError(
        422,
        "SPLIT_TOO_WIDE",
        `split requested ${children.length} children; the limit is ${cfg.max_fanout_children}`
      );
    }
    const task = (await c.query(`SELECT * FROM tasks WHERE task_id = $1 FOR UPDATE`, [taskId])).rows[0];
    if (!task) throw new ApiError(404, "NOT_FOUND", `task not found: ${taskId}`);
    if (task.status !== "RUNNING") {
      throw new ApiError(409, "STATE_CONFLICT", `task is ${task.status}; only a RUNNING task can be split`);
    }
    const attempt = (await c.query(`SELECT * FROM task_attempts WHERE attempt_id = $1 FOR UPDATE`, [
      task.current_attempt_id
    ])).rows[0];
    const lease = (await c.query(`SELECT * FROM leases WHERE attempt_id = $1 AND released_at IS NULL FOR UPDATE`, [
      attempt?.attempt_id
    ])).rows[0];
    if (!attempt || !lease) {
      throw new ApiError(409, "LEASE_EXPIRED", "the attempt has no active lease; cannot split");
    }
    if (Number(lease.fencing_token) !== Number(proof2.fencing_token)) {
      throw new ApiError(409, "FENCING_STALE", "fencing_token is stale; split rejected");
    }
    if (lease.lease_token !== proof2.lease_token) {
      throw new ApiError(409, "LEASE_MISMATCH", "lease_token does not match the current attempt");
    }
    if (proof2.auth_instance_id && proof2.auth_instance_id !== lease.instance_id) {
      throw new ApiError(403, "ROLE_NOT_ALLOWED", "instance tokens cannot split attempts of other instances");
    }
    const now = (await c.query(`SELECT app_now() AS t`)).rows[0].t;
    if (new Date(lease.expires_at).getTime() <= now.getTime()) {
      throw new ApiError(409, "LEASE_EXPIRED", "the lease has expired; cannot split");
    }
    if (Number(task.fanout_depth) + 1 > cfg.max_fanout_depth) {
      throw new ApiError(422, "SPLIT_TOO_DEEP", `fan-out depth limit (${cfg.max_fanout_depth}) reached`);
    }
    if (Number(task.fanout_rounds) + 1 > cfg.max_resume_rounds) {
      throw new ApiError(422, "SPLIT_TOO_MANY", `task already split ${task.fanout_rounds} times`);
    }
    const parentReq = isObject(task.requirements) ? task.requirements : {};
    const parentBuild = isObject(parentReq.build) ? parentReq.build : {};
    const attachments = Array.isArray(parentBuild.attachments) ? parentBuild.attachments : [];
    const requestedArtifacts = children.flatMap(
      (ch) => Array.isArray(ch.artifact_ids) ? ch.artifact_ids.map(String) : []
    );
    const allowedArtifacts = requestedArtifacts.length ? (await c.query(
      `SELECT artifact_id, actual_sha256, media_type FROM artifacts
              WHERE task_id = $1 AND status = 'COMPLETE' AND artifact_id = ANY($2::text[])`,
      [taskId, requestedArtifacts]
    )).rows : [];
    const inheritedUpstream = Array.isArray(parentReq.upstream_artifacts) ? parentReq.upstream_artifacts : [];
    const created = [];
    for (let index = 0; index < children.length; index++) {
      const child = children[index] ?? {};
      if (!child || typeof child !== "object" || Array.isArray(child)) {
        throw new ApiError(422, "SPLIT_INVALID", `child ${index} is not an object`);
      }
      const childType = String(child.task_type ?? task.task_type);
      const childReq = { ...isObject(child.requirements) ? child.requirements : {} };
      const childBuild = isObject(childReq.build) ? { ...childReq.build } : {};
      if (typeof child.title === "string" && child.title.trim()) childBuild.title = child.title.trim();
      else if (typeof parentBuild.title === "string" && !childBuild.title) childBuild.title = parentBuild.title;
      if (typeof child.instruction === "string" && child.instruction.trim()) {
        childBuild.instruction = child.instruction.trim();
      } else if (!childBuild.instruction) {
        throw new ApiError(422, "SPLIT_INVALID", `child ${index} has no instruction`);
      }
      if (!Array.isArray(childBuild.attachments) && attachments.length) {
        childBuild.attachments = attachments;
      }
      childReq.build = childBuild;
      childReq.fanout = { parent_task_id: taskId, index, total: children.length };
      const childArtifacts = child.artifact_ids?.length ? [
        ...inheritedUpstream,
        ...allowedArtifacts.filter((a) => child.artifact_ids.map(String).includes(a.artifact_id)).map((a) => ({
          artifact_id: a.artifact_id,
          sha256: a.actual_sha256,
          media_type: a.media_type,
          task_id: taskId,
          task_type: task.task_type
        }))
      ] : inheritedUpstream;
      if (childArtifacts.length) childReq.upstream_artifacts = childArtifacts;
      const row = await insertTask(c, {
        task_type: childType,
        parent_task_id: taskId,
        fanout_id: taskId,
        fanout_depth: Number(task.fanout_depth) + 1,
        priority_class: child.priority_class ?? task.priority_class,
        payload_ref: task.payload_ref ?? void 0,
        payload_sha256: task.payload_sha256 ?? void 0,
        payload_schema: task.payload_schema ?? "1.0",
        requirements: childReq,
        approval_mode: task.approval_mode,
        difficulty: child.difficulty,
        max_attempts: child.max_attempts,
        deadline_at: task.deadline_at ? new Date(task.deadline_at).toISOString() : void 0,
        trace_id: task.trace_id ?? void 0
      });
      created.push(row.task_id);
    }
    await c.query(
      `UPDATE task_attempts
          SET status = 'PARKED', park_reason = 'SPLIT', parked_at = app_now(),
              result_summary = $2
        WHERE attempt_id = $1`,
      [attempt.attempt_id, `split into ${created.length} child task(s)`]
    );
    await closeActiveLease(c, taskId, "TASK_SPLIT", "RELEASED");
    const updated = await c.query(
      `UPDATE tasks
          SET status = 'WAITING_CHILDREN', current_attempt_id = NULL,
              fanout_rounds = fanout_rounds + 1,
              version = version + 1, updated_at = app_now()
        WHERE task_id = $1 RETURNING *`,
      [taskId]
    );
    await appendEvent(c, {
      task_id: taskId,
      event_type: "TASK_SPLIT",
      from_status: "RUNNING",
      to_status: "WAITING_CHILDREN",
      actor: lease.instance_id,
      payload: { attempt_id: attempt.attempt_id, child_ids: created, depth: Number(task.fanout_depth) + 1 }
    });
    return { task: updated.rows[0], children: created };
  });
}
async function settleFanout(c, child) {
  const parentId = child.fanout_id;
  if (!parentId) return null;
  const siblings = (await c.query(
    `SELECT t.task_id, t.status, t.outcome, a.result_summary AS summary
         FROM tasks t
         LEFT JOIN LATERAL (
           SELECT result_summary FROM task_attempts
            WHERE task_id = t.task_id ORDER BY attempt_number DESC LIMIT 1
         ) a ON TRUE
        WHERE t.fanout_id = $1
        ORDER BY t.created_at, t.task_id`,
    [parentId]
  )).rows;
  if (siblings.some((s) => !["SUCCEEDED", "FAILED", "CANCELLED"].includes(s.status))) return null;
  const parent = (await c.query(`SELECT * FROM tasks WHERE task_id = $1 FOR UPDATE`, [parentId])).rows[0];
  if (!parent || parent.status !== "WAITING_CHILDREN") return null;
  const cfg = await loadConfig2(c);
  const summaries = siblings.map((s) => ({
    task_id: s.task_id,
    status: s.status,
    outcome: s.outcome,
    summary: s.summary ? String(s.summary).slice(0, 500) : null
  }));
  if (Number(parent.resume_rounds) >= cfg.max_resume_rounds) {
    await c.query(
      `UPDATE tasks
          SET status = 'FAILED', current_attempt_id = NULL, dead_letter = TRUE, outcome = 'children_exhausted',
              version = version + 1, updated_at = app_now()
        WHERE task_id = $1`,
      [parentId]
    );
    await appendEvent(c, {
      task_id: parentId,
      event_type: "TASK_DEAD_LETTERED",
      from_status: "WAITING_CHILDREN",
      to_status: "FAILED",
      actor: "scheduler",
      payload: { outcome: "children_exhausted", resume_rounds: Number(parent.resume_rounds), children: summaries }
    });
    return parentId;
  }
  const artifacts = (await c.query(
    `SELECT artifact_id, actual_sha256, media_type, task_id, task_type
         FROM artifacts a JOIN tasks t USING (task_id)
        WHERE a.task_id = ANY($1::text[]) AND a.status = 'COMPLETE'
        ORDER BY a.completed_at DESC, a.artifact_id DESC
        LIMIT 100`,
    [siblings.map((s) => s.task_id)]
  )).rows;
  const req = isObject(parent.requirements) ? parent.requirements : {};
  const inherited = Array.isArray(req.upstream_artifacts) ? req.upstream_artifacts : [];
  const refs = [
    ...inherited,
    ...artifacts.map((a) => ({
      artifact_id: a.artifact_id,
      sha256: a.actual_sha256,
      media_type: a.media_type,
      task_id: a.task_id,
      task_type: a.task_type
    }))
  ].filter((v, i, all) => all.findIndex((x) => x.artifact_id === v.artifact_id) === i);
  const requirements = {
    ...req,
    fanout_results: summaries,
    ...refs.length ? { upstream_artifacts: refs } : {}
  };
  assertTransition(parent.status, "QUEUED", "children_settled");
  const updated = await c.query(
    `UPDATE tasks
        SET status = 'QUEUED', current_attempt_id = NULL,
            requirements = $2,
            attempt_count = GREATEST(0, attempt_count - 1),
            resume_rounds = resume_rounds + 1,
            pending_question = NULL, needs_input_at = NULL, needs_input_expires_at = NULL,
            next_attempt_at = NULL, enqueued_at = app_now(),
            version = version + 1, updated_at = app_now()
      WHERE task_id = $1 RETURNING *`,
    [parentId, JSON.stringify(requirements)]
  );
  await appendEvent(c, {
    task_id: parentId,
    event_type: "TASK_CHILDREN_SETTLED",
    from_status: "WAITING_CHILDREN",
    to_status: "QUEUED",
    actor: "scheduler",
    payload: {
      children: summaries,
      artifacts: refs.slice(-50).map((r) => r.artifact_id),
      resume_rounds: Number(parent.resume_rounds) + 1
    }
  });
  return updated.rows[0]?.task_id ?? parentId;
}
async function cancelFanoutChildren(c, parentId, actor) {
  const cancelled = [];
  const rows = (await c.query(
    `SELECT task_id, status FROM tasks
        WHERE fanout_id = $1 AND status NOT IN ('SUCCEEDED','FAILED','CANCELLED')
        FOR UPDATE`,
    [parentId]
  )).rows;
  for (const row of rows) {
    await closeActiveLease(c, row.task_id, "PARENT_CANCELLED", "RELEASED");
    await c.query(
      `UPDATE task_attempts
          SET status = CASE WHEN status IN ('SUCCEEDED','FAILED','CANCELLED','TIMEOUT','PARKED')
                            THEN status ELSE 'CANCELLED' END,
              finished_at = COALESCE(finished_at, app_now())
        WHERE task_id = $1`,
      [row.task_id]
    );
    await c.query(
      `UPDATE tasks SET status = 'CANCELLED', current_attempt_id = NULL,
                        pending_question = NULL, needs_input_at = NULL, needs_input_expires_at = NULL,
                        version = version + 1, updated_at = app_now()
        WHERE task_id = $1`,
      [row.task_id]
    );
    await appendEvent(c, {
      task_id: row.task_id,
      event_type: "TASK_CANCELLED",
      from_status: row.status,
      to_status: "CANCELLED",
      actor,
      payload: { reason: "PARENT_CANCELLED", parent_task_id: parentId }
    });
    cancelled.push(row.task_id);
    cancelled.push(...await cancelFanoutChildren(c, row.task_id, actor));
  }
  return cancelled;
}

// scheduler/src/repo/failures.ts
import { createHash as createHash2 } from "node:crypto";
var MAX_SAMPLE = 240;
function normalizeFailure(text) {
  return String(text ?? "").replace(/```[\s\S]*?```/g, " <code> ").replace(/https?:\/\/\S+/gi, "<url>").replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "<email>").replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>").replace(/(?:[A-Za-z]:)?(?:[\\/][^\s:*?"<>|]+)+/g, "<path>").replace(/\b[0-9a-f]{16,}\b/gi, "<hex>").replace(/\b\d+(?:\.\d+)?\b/g, "<n>").replace(/\s+/g, " ").trim().slice(0, MAX_SAMPLE);
}
function failureKind(code) {
  const upper = code.toUpperCase();
  if (/TIMEOUT|DEADLINE/.test(upper)) return "timeout";
  if (/STALL/.test(upper)) return "stalled";
  if (/RATE_LIMIT|QUOTA|USAGE_LIMIT|TOO_MANY_REQUESTS/.test(upper)) return "rate_limit";
  if (/OUTWARD/.test(upper)) return "outward";
  if (/DIGEST|SCHEMA|INVALID|DENIED|NOT_ALLOWED|UNKNOWN/.test(upper)) return "permanent";
  return "error";
}
function failureSignature(code, message) {
  const sample = normalizeFailure(message);
  const digest = createHash2("sha256").update(`${code}|${sample}`).digest("hex").slice(0, 16);
  const kind = failureKind(code);
  return { signature: `${kind}:${digest}`, kind, sample };
}
async function recordFailureSignature(c, input) {
  const sig = failureSignature(input.code, input.message);
  await c.query(
    `INSERT INTO failure_signatures (signature, kind, code, sample, occurrences, first_seen_at, last_seen_at)
     VALUES ($1, $2, $3, $4, 1, app_now(), app_now())
     ON CONFLICT (signature) DO UPDATE
        SET occurrences = failure_signatures.occurrences + 1,
            sample = EXCLUDED.sample,
            last_seen_at = app_now()`,
    [sig.signature, sig.kind, input.code, sig.sample]
  );
  return sig.signature;
}
async function listFailureSignatures(limit) {
  const bounded = Math.min(200, Math.max(1, Number(limit) || 50));
  return q(
    `SELECT signature, kind, code, sample, occurrences, first_seen_at, last_seen_at
       FROM failure_signatures
      ORDER BY last_seen_at DESC
      LIMIT $1`,
    [bounded]
  );
}

// scheduler/src/core/attempts.ts
var NON_RETRYABLE = /* @__PURE__ */ new Set([
  "PAYLOAD_INVALID",
  "AUTH",
  "PERMISSION_DENIED",
  "SCHEMA_MISMATCH",
  "TASK_TYPE_UNKNOWN",
  "UPSTREAM_ARTIFACT_REQUIRED",
  "UPSTREAM_ARTIFACT_INVALID",
  "UPSTREAM_ARTIFACT_DIGEST_MISMATCH",
  "APPROVAL_REQUIRED",
  "APPROVAL_SUBJECT_CHANGED",
  "REVIEW_REJECTED_SECRET",
  "REVIEW_REJECTED_INCOMPLETE",
  // P4: permission violations/config mismatches are not solved by retrying
  "AGENT_PROFILE_NOT_ALLOWED",
  "API_PROFILE_NOT_ALLOWED",
  "TOOL_NOT_ALLOWED",
  "TOOL_UNKNOWN",
  "TOOL_PHASE_DENIED",
  "TOOL_SCOPE_DENIED",
  "TOOL_IDENTITY_MISMATCH",
  "TOOL_INPUT_INVALID",
  "TOOL_TURN_LIMIT",
  "TOOL_IDEMPOTENCY_CONFLICT",
  "WORKSPACE_PATH_DENIED",
  "ARTIFACT_PATH_DENIED"
]);
var RATE_LIMIT_CODES = /* @__PURE__ */ new Set([
  "PROVIDER_RATE_LIMITED",
  "RATE_LIMITED",
  "RATE_LIMIT",
  "USAGE_LIMIT",
  "QUOTA_EXCEEDED",
  "TOO_MANY_REQUESTS"
]);
var BUSY_CODES = /* @__PURE__ */ new Set(["AGENT_BUSY", "HOST_BUSY", "WORKSPACE_BUSY"]);
var MAX_RETRY_WAIVERS = 6;
var BUSY_RECHECK_SECONDS = 30;
var RATE_LIMIT_DEFAULT_WAIT_SECONDS = 15 * 60;
var RATE_LIMIT_MAX_WAIT_SECONDS = 12 * 3600;
function parseRetryAt(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value < 1e12 ? value * 1e3 : value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === "string" && value.trim()) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}
function planFailure(input) {
  if (input.outward) {
    return { failure_class: "outward", action: "dead", outcome: "interrupted_after_outward" };
  }
  const mayWait = input.waivers < MAX_RETRY_WAIVERS;
  if (RATE_LIMIT_CODES.has(input.code)) {
    if (!mayWait) return { failure_class: "rate_limit", action: "dead", outcome: "rate_limited" };
    const reset = parseRetryAt(input.retryAt);
    const byReset = reset ? Math.round((reset.getTime() - input.now.getTime()) / 1e3) : RATE_LIMIT_DEFAULT_WAIT_SECONDS;
    const wait = Math.min(RATE_LIMIT_MAX_WAIT_SECONDS, Math.max(60, byReset));
    return { failure_class: "rate_limit", action: "wait", outcome: "rate_limited_wait", wait_seconds: wait };
  }
  if (BUSY_CODES.has(input.code)) {
    if (!mayWait) return { failure_class: "busy", action: "dead", outcome: "error" };
    return { failure_class: "busy", action: "wait", outcome: "busy_wait", wait_seconds: BUSY_RECHECK_SECONDS };
  }
  if (NON_RETRYABLE.has(input.code)) {
    return { failure_class: "permanent", action: "dead", outcome: "error" };
  }
  if (input.attemptCount >= input.maxAttempts) {
    return { failure_class: "transient", action: "dead", outcome: "error" };
  }
  return { failure_class: "transient", action: "retry", outcome: "error", wait_seconds: input.backoffSeconds };
}
var DEFAULT_BACKOFF = [300, 900, 2700];
function backoffSeconds2(table, attemptCount) {
  const arr = Array.isArray(table) && table.length > 0 ? table : DEFAULT_BACKOFF;
  const idx = Math.min(Math.max(attemptCount - 1, 0), arr.length - 1);
  return arr[idx] ?? 300;
}
async function lockContext(c, attemptId, proof2) {
  const attempt = (await c.query(`SELECT * FROM task_attempts WHERE attempt_id = $1 FOR UPDATE`, [attemptId])).rows[0];
  if (!attempt) throw new ApiError(404, "NOT_FOUND", `attempt not found: ${attemptId}`);
  const task = (await c.query(`SELECT * FROM tasks WHERE task_id = $1 FOR UPDATE`, [attempt.task_id])).rows[0];
  const lease = (await c.query(`SELECT * FROM leases WHERE attempt_id = $1 FOR UPDATE`, [attemptId])).rows[0];
  const maxF = (await c.query(
    `SELECT COALESCE(MAX(fencing_token), 0) AS f FROM leases WHERE task_id = $1`,
    [attempt.task_id]
  )).rows[0].f;
  if (Number(proof2.fencing_token) < Number(maxF)) {
    throw new ApiError(409, "FENCING_STALE", "fencing_token is stale; write rejected", {
      task_id: attempt.task_id,
      current_fencing: Number(maxF),
      got: Number(proof2.fencing_token),
      attempt_id: attemptId
    });
  }
  if (!lease || lease.released_at) throw new ApiError(409, "LEASE_EXPIRED", "lease has been released or reclaimed");
  if (lease.lease_token !== proof2.lease_token) {
    throw new ApiError(409, "LEASE_MISMATCH", "lease_token does not match the current attempt");
  }
  if (Number(lease.fencing_token) !== Number(proof2.fencing_token)) {
    throw new ApiError(409, "FENCING_STALE", "fencing_token is stale; write rejected", {
      task_id: attempt.task_id,
      expected: Number(lease.fencing_token),
      got: Number(proof2.fencing_token)
    });
  }
  const nowRes = await c.query(`SELECT app_now() AS t`);
  const now = nowRes.rows[0].t;
  if (new Date(lease.expires_at).getTime() <= now.getTime()) {
    throw new ApiError(409, "LEASE_EXPIRED", "lease has expired");
  }
  if (proof2.instance_id && proof2.instance_id !== lease.instance_id) {
    throw new ApiError(409, "INSTANCE_MISMATCH", "this attempt does not belong to this instance");
  }
  if (proof2.auth_instance_id && proof2.auth_instance_id !== lease.instance_id) {
    throw new ApiError(403, "ROLE_NOT_ALLOWED", "instance tokens cannot operate on attempts of other instances", {
      token_sub: proof2.auth_instance_id,
      lease_owner: lease.instance_id
    });
  }
  return { attempt, task, lease, now };
}
async function startAck(attemptId, proof2) {
  return tx(async (c) => {
    const { attempt, task, lease } = await lockContext(c, attemptId, proof2);
    if (attempt.status === "STARTED") {
      return { attempt_id: attemptId, status: "STARTED", idempotent: true };
    }
    if (attempt.status !== "CREATED") {
      throw new ApiError(409, "STATE_CONFLICT", `attempt is already ${attempt.status}`);
    }
    if (proof2.accepted === false) {
      await c.query(
        `UPDATE task_attempts SET status = 'FAILED', finished_at = app_now(),
                                  error = $2 WHERE attempt_id = $1`,
        [attemptId, JSON.stringify({ code: "ADMISSION_DENIED_BY_HOST" })]
      );
      await closeActiveLease(c, task.task_id, "ADMISSION_REJECTED", "RELEASED");
      const updated = await c.query(
        `UPDATE tasks
            SET status = 'QUEUED', attempt_count = GREATEST(0, attempt_count - 1),
                current_attempt_id = NULL, version = version + 1, updated_at = app_now()
          WHERE task_id = $1 RETURNING *`,
        [task.task_id]
      );
      await appendEvent(c, {
        task_id: task.task_id,
        event_type: "ADMISSION_REJECTED",
        from_status: "ASSIGNED",
        to_status: "QUEUED",
        actor: lease.instance_id,
        payload: { attempt_id: attemptId, consumed_retry: false }
      });
      return { attempt_id: attemptId, status: "REJECTED", task: updated.rows[0] };
    }
    assertTransition(task.status, "RUNNING", "start_ack");
    await c.query(
      `UPDATE task_attempts SET status = 'STARTED', started_at = app_now() WHERE attempt_id = $1`,
      [attemptId]
    );
    await c.query(
      `UPDATE tasks SET status = 'RUNNING', version = version + 1, updated_at = app_now()
        WHERE task_id = $1`,
      [task.task_id]
    );
    await c.query(
      `UPDATE resource_reservations SET state = 'ACTIVE', activated_at = app_now()
        WHERE attempt_id = $1 AND state = 'HELD'`,
      [attemptId]
    );
    await appendEvent(c, {
      task_id: task.task_id,
      event_type: "TASK_STARTED",
      from_status: "ASSIGNED",
      to_status: "RUNNING",
      actor: lease.instance_id,
      payload: { attempt_id: attemptId, fencing_token: Number(lease.fencing_token) }
    });
    return { attempt_id: attemptId, status: "STARTED", task_id: task.task_id };
  });
}
async function renew(attemptId, proof2) {
  return tx(async (c) => {
    const { attempt } = await lockContext(c, attemptId, proof2);
    if (attempt.status === "STARTED" || attempt.status === "CREATED") {
      const res = await c.query(
        `UPDATE leases
            SET expires_at = app_now() + make_interval(secs =>
                  (SELECT lease_seconds FROM scheduler_config WHERE id = TRUE))
          WHERE attempt_id = $1 AND released_at IS NULL
          RETURNING expires_at`,
        [attemptId]
      );
      return { attempt_id: attemptId, lease_expires_at: res.rows[0].expires_at };
    }
    throw new ApiError(409, "STATE_CONFLICT", `attempt is already ${attempt.status}`);
  });
}
async function progress(attemptId, proof2) {
  return tx(async (c) => {
    const { attempt, task, lease } = await lockContext(c, attemptId, proof2);
    const added = mergeOutward(attempt.outward_actions, proof2.outward);
    if (added.length) {
      await c.query(`UPDATE task_attempts SET outward_actions = $2 WHERE attempt_id = $1`, [
        attemptId,
        JSON.stringify(added)
      ]);
    }
    await appendEvent(c, {
      task_id: task.task_id,
      event_type: added.length && proof2.outward?.length ? "TASK_OUTWARD_ACTION" : "TASK_PROGRESS",
      from_status: task.status,
      to_status: task.status,
      actor: lease.instance_id,
      payload: {
        attempt_id: attemptId,
        percent: proof2.percent ?? null,
        note: proof2.note ?? null,
        ...added.length ? { outward_actions: added } : {}
      }
    });
    return { ok: true, outward_actions: added };
  });
}
function mergeOutward(existing, incoming) {
  const out = /* @__PURE__ */ new Set();
  for (const v of Array.isArray(existing) ? existing : []) out.add(String(v));
  for (const v of Array.isArray(incoming) ? incoming : []) {
    const action = String(v).trim();
    if (action) out.add(action.slice(0, 200));
  }
  return [...out];
}
async function submitResult(attemptId, input) {
  return tx(async (c) => {
    const attemptRow = (await c.query(`SELECT * FROM task_attempts WHERE attempt_id = $1 FOR UPDATE`, [attemptId])).rows[0];
    if (!attemptRow) throw new ApiError(404, "NOT_FOUND", `attempt not found: ${attemptId}`);
    if (["SUCCEEDED", "FAILED", "CANCELLED", "PARKED"].includes(attemptRow.status)) {
      return {
        idempotent: true,
        attempt_id: attemptId,
        task_id: attemptRow.task_id,
        attempt_status: attemptRow.status,
        result_summary: attemptRow.result_summary
      };
    }
    const { attempt, task, lease, now } = await lockContext(c, attemptId, input);
    if (!["RUNNING", "ASSIGNED"].includes(task.status)) {
      throw new ApiError(409, "STATE_CONFLICT", `task state ${task.status} does not accept results`);
    }
    if (task.status === "ASSIGNED") {
      throw new ApiError(409, "STATE_CONFLICT", "task has not been start-acked; results are not accepted");
    }
    const outward = mergeOutward(attempt.outward_actions, input.outward_actions);
    if (outward.length !== (Array.isArray(attempt.outward_actions) ? attempt.outward_actions.length : 0)) {
      await c.query(`UPDATE task_attempts SET outward_actions = $2 WHERE attempt_id = $1`, [
        attemptId,
        JSON.stringify(outward)
      ]);
    }
    if (input.status === "NEEDS_INPUT") {
      const question = String(input.question ?? "").trim();
      if (!question) {
        throw new ApiError(422, "QUESTION_REQUIRED", "NEEDS_INPUT requires a non-empty question");
      }
      assertTransition(task.status, "NEEDS_INPUT", "agent_needs_input");
      const ttl = Number(
        (await c.query(`SELECT needs_input_ttl_seconds FROM scheduler_config WHERE id = TRUE`)).rows[0]?.needs_input_ttl_seconds
      ) || 86400;
      await c.query(
        `UPDATE task_attempts
            SET status = 'PARKED', park_reason = 'NEEDS_INPUT', parked_at = app_now(),
                result_summary = $2
          WHERE attempt_id = $1`,
        [attemptId, String(input.summary ?? question).slice(0, 500)]
      );
      await closeActiveLease(c, task.task_id, "NEEDS_INPUT", "RELEASED");
      const updated2 = await c.query(
        `UPDATE tasks
            SET status = 'NEEDS_INPUT', current_attempt_id = NULL,
                pending_question = $2,
                needs_input_at = app_now(),
                needs_input_expires_at = app_now() + make_interval(secs => $3),
                version = version + 1, updated_at = app_now()
          WHERE task_id = $1 RETURNING *`,
        [
          task.task_id,
          JSON.stringify({ question: question.slice(0, 4e3), attempt_id: attemptId, asked_at: (/* @__PURE__ */ new Date()).toISOString() }),
          ttl
        ]
      );
      await appendEvent(c, {
        task_id: task.task_id,
        event_type: "TASK_NEEDS_INPUT",
        from_status: task.status,
        to_status: "NEEDS_INPUT",
        actor: lease.instance_id,
        // The question may contain business detail; the event keeps its shape, not its text.
        payload: { attempt_id: attemptId, question_chars: question.length, expires_in_seconds: ttl }
      });
      return { task: updated2.rows[0], attempt_status: "PARKED", needs_input: true };
    }
    if (input.status === "SUCCEEDED") {
      assertTransition(task.status, "SUCCEEDED", "result_succeeded");
      const outcome2 = input.outcome ?? "completed";
      await c.query(
        `UPDATE task_attempts SET status = 'SUCCEEDED', result_summary = $2,
                                  outputs = $3, outcome = $4, finished_at = app_now()
          WHERE attempt_id = $1`,
        [attemptId, input.summary ?? null, input.outputs ? JSON.stringify(input.outputs) : null, outcome2]
      );
      const updated2 = await c.query(
        `UPDATE tasks SET status = 'SUCCEEDED', outcome = $2, current_attempt_id = NULL,
                          version = version + 1, updated_at = app_now()
          WHERE task_id = $1 RETURNING *`,
        [task.task_id, outcome2]
      );
      await closeActiveLease(c, task.task_id, "SUCCEEDED", "RELEASED");
      await appendEvent(c, {
        task_id: task.task_id,
        event_type: "TASK_SUCCEEDED",
        from_status: task.status,
        to_status: "SUCCEEDED",
        actor: lease.instance_id,
        payload: {
          attempt_id: attemptId,
          summary: input.summary ?? null,
          outcome: outcome2,
          ...outward.length ? { outward_actions: outward } : {}
        }
      });
      await advanceWorkflow(c, task, "SUCCEEDED");
      await settleFanout(c, { task_id: task.task_id, fanout_id: task.fanout_id });
      return { task: updated2.rows[0], attempt_status: "SUCCEEDED", outcome: outcome2 };
    }
    if (input.status === "CANCELLED") {
      assertTransition(task.status, "CANCELLED", "cancel_ack");
      await c.query(
        `UPDATE task_attempts SET status = 'CANCELLED', outcome = 'cancelled', finished_at = app_now()
          WHERE attempt_id = $1`,
        [attemptId]
      );
      const updated2 = await c.query(
        `UPDATE tasks SET status = 'CANCELLED', outcome = 'cancelled', current_attempt_id = NULL,
                          version = version + 1, updated_at = app_now()
          WHERE task_id = $1 RETURNING *`,
        [task.task_id]
      );
      await closeActiveLease(c, task.task_id, "TASK_CANCELLED", "RELEASED");
      await appendEvent(c, {
        task_id: task.task_id,
        event_type: "TASK_CANCELLED",
        from_status: task.status,
        to_status: "CANCELLED",
        actor: lease.instance_id,
        payload: { attempt_id: attemptId, confirmed: true }
      });
      await advanceWorkflow(c, task, "CANCELLED");
      await settleFanout(c, { task_id: task.task_id, fanout_id: task.fanout_id });
      return { task: updated2.rows[0], attempt_status: "CANCELLED" };
    }
    const code = input.error?.code ?? "UNKNOWN";
    const outwardFailure = outward.length > 0;
    const cfg = (await c.query(
      `SELECT retry_backoff_seconds FROM scheduler_config WHERE id = TRUE`
    )).rows[0];
    const backoff = backoffSeconds2(cfg.retry_backoff_seconds, task.attempt_count);
    const detail = input.error?.detail ?? {};
    const plan = planFailure({
      code,
      outward: outwardFailure,
      retryAt: detail.retry_at ?? detail.reset_at,
      now,
      attemptCount: task.attempt_count,
      maxAttempts: task.max_attempts,
      waivers: Number(task.retry_waivers ?? 0),
      backoffSeconds: backoff
    });
    const outcome = input.outcome ?? plan.outcome;
    const signature = await recordFailureSignature(c, {
      code,
      message: input.error?.message ?? input.summary ?? code
    });
    await c.query(
      `UPDATE task_attempts
          SET status = 'FAILED', error = $2, outcome = $3, failure_class = $4,
              failure_signature = $5, finished_at = app_now()
        WHERE attempt_id = $1`,
      [attemptId, JSON.stringify(input.error ?? { code }), outcome, plan.failure_class, signature]
    );
    await closeActiveLease(c, task.task_id, "ATTEMPT_FAILED", "RELEASED");
    const priorFailure = {
      attempt_number: Number(attempt.attempt_number ?? task.attempt_count),
      builder: lease.instance_id,
      error_code: code,
      failure_class: plan.failure_class,
      outcome,
      at: new Date(now).toISOString(),
      ...outward.length ? { outward_actions: outward } : {}
    };
    const priorJson = JSON.stringify({ prior_failure: priorFailure });
    if (plan.action === "wait") {
      assertTransition(task.status, "QUEUED", "result_failed_wait");
      const updated2 = await c.query(
        `UPDATE tasks
            SET status = 'QUEUED', current_attempt_id = NULL,
                attempt_count = GREATEST(0, attempt_count - 1),
                retry_waivers = retry_waivers + 1,
                next_attempt_at = app_now() + make_interval(secs => $2),
                requirements = COALESCE(requirements, '{}'::jsonb) || $3::jsonb,
                version = version + 1, updated_at = app_now()
          WHERE task_id = $1 RETURNING *`,
        [task.task_id, plan.wait_seconds ?? 60, priorJson]
      );
      await appendEvent(c, {
        task_id: task.task_id,
        event_type: "TASK_RETRY_WAITED",
        from_status: task.status,
        to_status: "QUEUED",
        actor: lease.instance_id,
        payload: {
          attempt_id: attemptId,
          error_code: code,
          failure_class: plan.failure_class,
          failure_signature: signature,
          wait_reason: plan.outcome,
          wait_seconds: plan.wait_seconds ?? 60,
          retry_waivers: Number(task.retry_waivers ?? 0) + 1,
          ...outward.length ? { outward_actions: outward } : {}
        }
      });
      return {
        task: updated2.rows[0],
        attempt_status: "FAILED",
        retry_in_seconds: plan.wait_seconds ?? 60,
        outcome,
        failure_class: plan.failure_class
      };
    }
    if (plan.action === "retry") {
      assertTransition(task.status, "QUEUED", "result_failed_retryable");
      const updated2 = await c.query(
        `UPDATE tasks
            SET status = 'QUEUED', current_attempt_id = NULL,
                next_attempt_at = app_now() + make_interval(secs => $2),
                requirements = COALESCE(requirements, '{}'::jsonb) || $3::jsonb,
                version = version + 1, updated_at = app_now()
          WHERE task_id = $1 RETURNING *`,
        [task.task_id, backoff, priorJson]
      );
      await appendEvent(c, {
        task_id: task.task_id,
        event_type: "TASK_RETRY_SCHEDULED",
        from_status: task.status,
        to_status: "QUEUED",
        actor: lease.instance_id,
        payload: {
          attempt_id: attemptId,
          error_code: code,
          failure_class: plan.failure_class,
          failure_signature: signature,
          attempt_count: task.attempt_count,
          max_attempts: task.max_attempts,
          backoff_seconds: backoff,
          ...outward.length ? { outward_actions: outward } : {}
        }
      });
      return {
        task: updated2.rows[0],
        attempt_status: "FAILED",
        retry_in_seconds: backoff,
        outcome,
        failure_class: plan.failure_class
      };
    }
    assertTransition(task.status, "FAILED", "result_failed_retry_exhausted");
    const updated = await c.query(
      `UPDATE tasks SET status = 'FAILED', outcome = $2, current_attempt_id = NULL, dead_letter = TRUE,
                        version = version + 1, updated_at = app_now()
        WHERE task_id = $1 RETURNING *`,
      [task.task_id, outcome]
    );
    await appendEvent(c, {
      task_id: task.task_id,
      event_type: "TASK_DEAD_LETTERED",
      from_status: task.status,
      to_status: "FAILED",
      actor: lease.instance_id,
      payload: {
        attempt_id: attemptId,
        error_code: code,
        failure_class: plan.failure_class,
        failure_signature: signature,
        outcome,
        attempt_count: task.attempt_count,
        non_retryable: plan.failure_class === "permanent" || plan.failure_class === "outward",
        retry_waivers: Number(task.retry_waivers ?? 0),
        ...outward.length ? { outward_actions: outward } : {},
        alert: "P1"
      }
    });
    await advanceWorkflow(c, task, "FAILED");
    await settleFanout(c, { task_id: task.task_id, fanout_id: task.fanout_id });
    return {
      task: updated.rows[0],
      attempt_status: "FAILED",
      dead_letter: true,
      outcome,
      failure_class: plan.failure_class
    };
  });
}

// scheduler/src/core/artifacts.ts
import { createHash as createHash3 } from "node:crypto";
import fs2 from "node:fs";
import path from "node:path";
var MAX_BYTES = 64 * 1024 * 1024;
function artifactDir() {
  return path.resolve(process.env.ARTIFACT_DIR ?? "data/artifacts");
}
function ensureDir() {
  const dir = artifactDir();
  fs2.mkdirSync(dir, { recursive: true });
  return dir;
}
function normalizeDigest(value) {
  const hex = value.startsWith("sha256:") ? value.slice(7) : value;
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new ApiError(400, "BAD_REQUEST", "sha256 must be 64 hex characters");
  }
  return `sha256:${hex.toLowerCase()}`;
}
function digestOf(data) {
  return `sha256:${createHash3("sha256").update(data).digest("hex")}`;
}
function normalizeName(value) {
  const raw = String(value ?? "").replace(/\\/g, "/").trim();
  if (!raw) return null;
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, "").replace(/^\/+/, "").slice(0, 300);
  return name || null;
}
async function createArtifact(input, instanceId) {
  if (!input.task_id) throw new ApiError(400, "BAD_REQUEST", "task_id is required");
  const declared = normalizeDigest(input.sha256);
  const task = await q1(`SELECT task_id FROM tasks WHERE task_id = $1`, [input.task_id]);
  if (!task) throw new ApiError(404, "NOT_FOUND", `task not found: ${input.task_id}`);
  let owner = instanceId;
  if (input.attempt_id) {
    const attempt = await q1(
      `SELECT task_id, instance_id FROM task_attempts WHERE attempt_id = $1`,
      [input.attempt_id]
    );
    if (!attempt) throw new ApiError(404, "NOT_FOUND", `attempt not found: ${input.attempt_id}`);
    if (attempt.task_id !== input.task_id) {
      throw new ApiError(409, "STATE_CONFLICT", "attempt does not belong to this task");
    }
    if (instanceId && attempt.instance_id !== instanceId) {
      throw new ApiError(403, "ROLE_NOT_ALLOWED", "artifacts may only be uploaded for your own attempt");
    }
    owner = attempt.instance_id;
  }
  if (!owner) throw new ApiError(400, "BAD_REQUEST", "missing instance_id");
  const artifactId = newId("art");
  const row = await q1(
    `INSERT INTO artifacts
         (artifact_id, task_id, attempt_id, instance_id, status, declared_sha256,
          size_bytes, media_type, storage_ref, name)
       VALUES ($1,$2,$3,$4,'PENDING',$5,$6,$7,$8,$9)
       RETURNING *`,
    [
      artifactId,
      input.task_id,
      input.attempt_id ?? null,
      owner,
      declared,
      input.size_bytes ?? null,
      input.media_type ?? "application/octet-stream",
      `${artifactId}.bin`,
      normalizeName(input.name)
    ]
  );
  return {
    ...row,
    upload: {
      method: "PUT",
      path: `/v1/artifacts/${artifactId}/content`,
      complete_path: `/v1/artifacts/${artifactId}/complete`
    }
  };
}
function storagePath(storageRef) {
  return path.join(ensureDir(), path.basename(storageRef));
}
async function putArtifactContent(artifactId, data, instanceId) {
  if (data.length > MAX_BYTES) {
    throw new ApiError(413, "PAYLOAD_TOO_LARGE", "artifact exceeds 64MB");
  }
  const row = await q1(`SELECT * FROM artifacts WHERE artifact_id = $1`, [artifactId]);
  if (!row) throw new ApiError(404, "NOT_FOUND", `artifact not found: ${artifactId}`);
  if (instanceId && row.instance_id !== instanceId) {
    throw new ApiError(403, "ROLE_NOT_ALLOWED", "artifacts may only be uploaded for your own instance");
  }
  if (row.status !== "PENDING") {
    throw new ApiError(409, "STATE_CONFLICT", `artifact is already ${row.status}`);
  }
  const file = storagePath(row.storage_ref);
  const tmp = `${file}.${process.pid}.tmp`;
  fs2.writeFileSync(tmp, data);
  fs2.renameSync(tmp, file);
  await q(`UPDATE artifacts SET size_bytes = $2 WHERE artifact_id = $1`, [artifactId, data.length]);
  return { artifact_id: artifactId, size_bytes: data.length };
}
async function completeArtifact(artifactId, instanceId) {
  const row = await q1(`SELECT * FROM artifacts WHERE artifact_id = $1`, [artifactId]);
  if (!row) throw new ApiError(404, "NOT_FOUND", `artifact not found: ${artifactId}`);
  if (instanceId && row.instance_id !== instanceId) {
    throw new ApiError(403, "ROLE_NOT_ALLOWED", "artifacts may only be confirmed for your own instance");
  }
  if (row.status === "COMPLETE") {
    return { ...row, idempotent: true };
  }
  if (row.status !== "PENDING") {
    throw new ApiError(409, "STATE_CONFLICT", `artifact is already ${row.status}`);
  }
  const file = storagePath(row.storage_ref);
  if (!fs2.existsSync(file)) {
    throw new ApiError(409, "ARTIFACT_NOT_UPLOADED", "artifact content has not been uploaded");
  }
  const actual = digestOf(fs2.readFileSync(file));
  if (actual !== row.declared_sha256) {
    await q(`UPDATE artifacts SET status = 'FAILED', actual_sha256 = $2 WHERE artifact_id = $1`, [
      artifactId,
      actual
    ]);
    throw new ApiError(422, "ARTIFACT_DIGEST_MISMATCH", "artifact content does not match the declared digest", {
      declared: row.declared_sha256,
      actual
    });
  }
  const updated = await q1(
    `UPDATE artifacts
        SET status = 'COMPLETE', actual_sha256 = $2, completed_at = app_now()
      WHERE artifact_id = $1
      RETURNING *`,
    [artifactId, actual]
  );
  return updated;
}
async function getArtifact(artifactId) {
  const row = await q1(`SELECT * FROM artifacts WHERE artifact_id = $1`, [artifactId]);
  if (!row) throw new ApiError(404, "NOT_FOUND", `artifact not found: ${artifactId}`);
  return row;
}
async function listTaskArtifacts(taskId) {
  const task = await q1(`SELECT task_id FROM tasks WHERE task_id = $1`, [taskId]);
  if (!task) throw new ApiError(404, "NOT_FOUND", `task not found: ${taskId}`);
  return q(
    `SELECT artifact_id, task_id, attempt_id, instance_id, status, name, media_type,
            size_bytes, declared_sha256, actual_sha256, created_at, completed_at
       FROM artifacts
      WHERE task_id = $1
      ORDER BY created_at, artifact_id`,
    [taskId]
  );
}
function downloadFilename(row) {
  const base = String(row.name ?? "").split("/").filter(Boolean).pop();
  if (base) return base;
  const type = String(row.media_type ?? "").toLowerCase();
  const ext = type === "application/json" ? ".json" : type === "text/plain" ? ".txt" : type === "text/markdown" ? ".md" : type === "application/pdf" ? ".pdf" : type === "image/png" ? ".png" : type === "image/jpeg" ? ".jpg" : type === "application/zip" ? ".zip" : type === "application/gzip" ? ".gz" : ".bin";
  return `${row.artifact_id}${ext}`;
}
async function readArtifactContent(artifactId, instanceId) {
  const row = await q1(`SELECT * FROM artifacts WHERE artifact_id = $1`, [artifactId]);
  if (!row) throw new ApiError(404, "NOT_FOUND", `artifact not found: ${artifactId}`);
  if (row.status !== "COMPLETE") {
    throw new ApiError(409, "STATE_CONFLICT", `artifact has not passed verification: ${row.status}`);
  }
  if (instanceId && row.instance_id !== instanceId) {
    const allowed = await q1(
      `SELECT 1
         FROM task_attempts a
         JOIN tasks t ON t.task_id = a.task_id
        WHERE a.instance_id = $2
          AND a.status IN ('CREATED','STARTED')
          AND EXISTS (
            SELECT 1
              FROM jsonb_array_elements(
                     COALESCE(t.requirements->'upstream_artifacts', '[]'::jsonb)) e
             WHERE e->>'artifact_id' = $1)
        LIMIT 1`,
      [artifactId, instanceId]
    );
    if (!allowed) {
      throw new ApiError(403, "ROLE_NOT_ALLOWED", "you may only read artifacts of your own instance, or upstream artifacts handed to the current task by the scheduler");
    }
  }
  const file = storagePath(row.storage_ref);
  if (!fs2.existsSync(file)) throw new ApiError(409, "ARTIFACT_NOT_UPLOADED", "artifact content does not exist");
  return {
    artifact_id: row.artifact_id,
    name: row.name ?? null,
    media_type: row.media_type ?? "application/octet-stream",
    sha256: row.actual_sha256,
    data: fs2.readFileSync(file)
  };
}

// scheduler/src/repo/tasks.ts
async function createTask(input) {
  return tx((c) => insertTask(c, input));
}
async function getTask(taskId) {
  const task = await q1("SELECT * FROM tasks WHERE task_id = $1", [taskId]);
  if (!task) throw new ApiError(404, "NOT_FOUND", `task not found: ${taskId}`);
  const attempts = await q(
    `SELECT attempt_id, attempt_number, instance_id, status, result_summary, outputs,
            error, started_at, finished_at
       FROM task_attempts WHERE task_id = $1 ORDER BY attempt_number`,
    [taskId]
  );
  const lease = await q1(
    `SELECT lease_token, attempt_id, fencing_token, issued_at, expires_at
       FROM leases WHERE task_id = $1 AND released_at IS NULL`,
    [taskId]
  );
  const relay = await q1(
    `SELECT child_node_id, child_url, child_task_id, state, child_state,
            child_result, sync_failures, last_error, created_at, updated_at
       FROM task_relays WHERE parent_task_id = $1`,
    [taskId]
  );
  const children = await q(
    `SELECT task_id, task_type, status, outcome, parent_task_id, fanout_id,
            requirements->'build'->>'title' AS title,
            created_at, updated_at
       FROM tasks WHERE parent_task_id = $1
      ORDER BY created_at, task_id`,
    [taskId]
  );
  return { ...task, attempts, lease, relay: relay ?? null, children };
}
async function listTasks(filter) {
  const where = [];
  const params = [];
  if (filter.status) {
    params.push(filter.status);
    where.push(`t.status = $${params.length}`);
  }
  if (filter.task_type) {
    params.push(filter.task_type);
    where.push(`t.task_type = $${params.length}`);
  }
  if (filter.role) {
    params.push(filter.role);
    where.push(`td.target_role = $${params.length}`);
  }
  params.push(Math.min(filter.limit ?? 100, 500));
  return q(
    `SELECT t.*, td.target_role,
            a.instance_id AS current_instance_id,
            a.attempt_number AS current_attempt_number
       FROM tasks t
       JOIN task_definitions td USING (task_type)
       LEFT JOIN task_attempts a ON a.attempt_id = t.current_attempt_id
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY t.enqueued_at DESC, t.task_id
      LIMIT $${params.length}`,
    params
  );
}
async function listEvents(taskId) {
  return q(
    `SELECT event_id::text, event_type, from_status, to_status, actor, payload, created_at
       FROM task_events WHERE task_id = $1 ORDER BY event_id`,
    [taskId]
  );
}
async function retryTask(taskId, actor = "operator") {
  return tx(async (c) => {
    const row = (await c.query(`SELECT * FROM tasks WHERE task_id = $1 FOR UPDATE`, [taskId])).rows[0];
    if (!row) throw new ApiError(404, "NOT_FOUND", `task not found: ${taskId}`);
    const from = row.status;
    if (from !== "FAILED" && from !== "CANCELLED") {
      throw new ApiError(
        409,
        "STATE_CONFLICT",
        `task is ${from}; only a FAILED or CANCELLED task can be retried`
      );
    }
    const updated = await c.query(
      `UPDATE tasks
          SET status = 'QUEUED', attempt_count = 0, dead_letter = FALSE,
              current_attempt_id = NULL, next_attempt_at = NULL,
              cancel_requested_at = NULL, resource_block_reason = NULL,
              resource_evaluated_at = NULL, resource_retry_after = NULL,
              blocked_attempts = 0, unschedulable = FALSE, result_summary = NULL,
              outcome = NULL, pending_question = NULL,
              needs_input_at = NULL, needs_input_expires_at = NULL, resume_rounds = 0,
              enqueued_at = app_now(), version = version + 1, updated_at = app_now()
        WHERE task_id = $1 RETURNING *`,
      [taskId]
    );
    await appendEvent(c, {
      task_id: taskId,
      event_type: "TASK_REQUEUED",
      from_status: from,
      to_status: "QUEUED",
      actor,
      payload: { previous_attempts: Number(row.attempt_count ?? 0) }
    });
    return updated.rows[0];
  });
}
async function cancelTask(taskId, actor = "operator") {
  return tx(async (c) => {
    const row = (await c.query(`SELECT * FROM tasks WHERE task_id = $1 FOR UPDATE`, [taskId])).rows[0];
    if (!row) throw new ApiError(404, "NOT_FOUND", `task not found: ${taskId}`);
    const from = row.status;
    if (isTerminal(from)) {
      throw new ApiError(409, "STATE_CONFLICT", `task is already terminal (${from}); cannot cancel`);
    }
    if (from === "RUNNING") {
      await c.query(
        `UPDATE tasks SET cancel_requested_at = COALESCE(cancel_requested_at, app_now()),
                          version = version + 1, updated_at = app_now()
          WHERE task_id = $1`,
        [taskId]
      );
      await appendEvent(c, {
        task_id: taskId,
        event_type: "CANCEL_REQUESTED",
        from_status: from,
        to_status: from,
        actor
      });
      return { ...row, cancel_requested_at: /* @__PURE__ */ new Date(), status: from };
    }
    assertTransition(from, "CANCELLED", "operator_cancel");
    await closeActiveLease(c, taskId, "CANCEL_REQUESTED");
    const updated = await c.query(
      `UPDATE tasks SET status = 'CANCELLED', outcome = 'cancelled', current_attempt_id = NULL,
                        pending_question = NULL, needs_input_at = NULL, needs_input_expires_at = NULL,
                        version = version + 1, updated_at = app_now()
        WHERE task_id = $1 RETURNING *`,
      [taskId]
    );
    await appendEvent(c, {
      task_id: taskId,
      event_type: "TASK_CANCELLED",
      from_status: from,
      to_status: "CANCELLED",
      actor
    });
    const cancelledChildren = await cancelFanoutChildren(c, taskId, actor);
    if (cancelledChildren.length) {
      await appendEvent(c, {
        task_id: taskId,
        event_type: "TASK_CHILDREN_CANCELLED",
        from_status: "CANCELLED",
        to_status: "CANCELLED",
        actor,
        payload: { child_ids: cancelledChildren }
      });
    }
    await advanceWorkflow(c, row, "CANCELLED");
    await settleFanout(c, { task_id: taskId, fanout_id: row.fanout_id });
    return updated.rows[0];
  });
}
async function answerTask(taskId, answer, actor = "operator") {
  const text = String(answer ?? "").trim();
  if (!text) throw new ApiError(422, "ANSWER_REQUIRED", "answer must not be empty");
  return tx(async (c) => {
    const row = (await c.query(`SELECT * FROM tasks WHERE task_id = $1 FOR UPDATE`, [taskId])).rows[0];
    if (!row) throw new ApiError(404, "NOT_FOUND", `task not found: ${taskId}`);
    if (row.status !== "NEEDS_INPUT") {
      throw new ApiError(409, "STATE_CONFLICT", `task is ${row.status}; it is not waiting for an answer`);
    }
    const cfg = (await c.query(`SELECT max_resume_rounds FROM scheduler_config WHERE id = TRUE`)).rows[0];
    const maxRounds = Number(cfg?.max_resume_rounds) || 8;
    if (Number(row.resume_rounds) >= maxRounds) {
      const failed = await c.query(
        `UPDATE tasks SET status = 'FAILED', outcome = 'input_exhausted', dead_letter = TRUE,
                          current_attempt_id = NULL, version = version + 1, updated_at = app_now()
          WHERE task_id = $1 RETURNING *`,
        [taskId]
      );
      await appendEvent(c, {
        task_id: taskId,
        event_type: "TASK_DEAD_LETTERED",
        from_status: "NEEDS_INPUT",
        to_status: "FAILED",
        actor,
        payload: { outcome: "input_exhausted", resume_rounds: Number(row.resume_rounds) }
      });
      return { ...failed.rows[0], answer_rejected: "TOO_MANY_RESUMES" };
    }
    const req = row.requirements && typeof row.requirements === "object" ? row.requirements : {};
    const answers = Array.isArray(req.input_answers) ? req.input_answers : [];
    const question = row.pending_question?.question ?? null;
    const requirements = {
      ...req,
      input_answers: [
        ...answers,
        { question, answer: text.slice(0, 8e3), at: (/* @__PURE__ */ new Date()).toISOString(), actor }
      ].slice(-20)
    };
    const updated = await c.query(
      `UPDATE tasks
          SET status = 'QUEUED', current_attempt_id = NULL,
              requirements = $2,
              pending_question = NULL, needs_input_at = NULL, needs_input_expires_at = NULL,
              attempt_count = GREATEST(0, attempt_count - 1),
              resume_rounds = resume_rounds + 1,
              next_attempt_at = NULL, enqueued_at = app_now(),
              version = version + 1, updated_at = app_now()
        WHERE task_id = $1 RETURNING *`,
      [taskId, JSON.stringify(requirements)]
    );
    await appendEvent(c, {
      task_id: taskId,
      event_type: "TASK_ANSWERED",
      from_status: "NEEDS_INPUT",
      to_status: "QUEUED",
      actor,
      // The answer itself is business content and stays in requirements, not in the event log.
      payload: { question_chars: question ? String(question).length : 0, answer_chars: text.length }
    });
    return updated.rows[0];
  });
}

// scheduler/src/repo/outbox.ts
async function listOutbox(after, limit = 200) {
  return q(
    `SELECT * FROM outbox_events WHERE event_id > $1 ORDER BY event_id LIMIT $2`,
    [after, Math.min(Math.max(limit, 1), 1e3)]
  );
}
async function latestEventId() {
  const row = await q1(`SELECT max(event_id) AS id FROM outbox_events`);
  return Number(row?.id ?? 0);
}

// scheduler/src/repo/hosts.ts
var STATES = /* @__PURE__ */ new Set(["NORMAL", "WARNING", "THROTTLED", "PROTECTING", "RECOVERING"]);
var PRESSURE = /* @__PURE__ */ new Set(["NORMAL", "BUSY", "PRESSURE", "CRITICAL", "RECOVERING"]);
var nonNeg = (value) => Math.max(0, Math.trunc(Number(value) || 0));
async function upsertPoolRow(c, hostId, pool2) {
  const instances = Array.isArray(pool2.instances) ? pool2.instances : [];
  const old = (await c.query(
    `SELECT cpu_used_millicores, mem_used_bytes, mem_working_set_bytes
         FROM host_resource_pools WHERE host_id = $1`,
    [hostId]
  )).rows[0];
  const alpha = Math.max(0, Math.min(1, config.dynamicPolicy.ewma_alpha));
  const smooth = (next, prev) => prev === void 0 ? next : Math.round(alpha * next + (1 - alpha) * Number(prev));
  const cpuUsed = smooth(nonNeg(pool2.cpu_used_millicores), old?.cpu_used_millicores);
  const memUsed = smooth(nonNeg(pool2.mem_used_bytes), old?.mem_used_bytes);
  const workingSet = nonNeg(pool2.mem_working_set_bytes) || memUsed;
  const pressure = String(pool2.pressure_state ?? "").toUpperCase();
  await c.query(
    `INSERT INTO host_resource_pools
       (host_id, pool_id, cgroup_available, cgroup_driver,
        cpu_total_millicores, mem_total_bytes,
        cpu_used_millicores, mem_used_bytes, mem_working_set_bytes,
        psi, cgroup, reported_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,COALESCE($12::timestamptz,app_now()),app_now())
     ON CONFLICT (host_id) DO UPDATE SET
       pool_id = EXCLUDED.pool_id,
       cgroup_available = EXCLUDED.cgroup_available,
       cgroup_driver = EXCLUDED.cgroup_driver,
       cpu_total_millicores = CASE WHEN EXCLUDED.cpu_total_millicores > 0 THEN EXCLUDED.cpu_total_millicores ELSE host_resource_pools.cpu_total_millicores END,
       mem_total_bytes = CASE WHEN EXCLUDED.mem_total_bytes > 0 THEN EXCLUDED.mem_total_bytes ELSE host_resource_pools.mem_total_bytes END,
       cpu_used_millicores = EXCLUDED.cpu_used_millicores,
       mem_used_bytes = EXCLUDED.mem_used_bytes,
       mem_working_set_bytes = EXCLUDED.mem_working_set_bytes,
       pressure_state = CASE WHEN $13::text = ANY('{NORMAL,BUSY,PRESSURE,CRITICAL,RECOVERING}'::text[]) THEN $13::text ELSE host_resource_pools.pressure_state END,
       psi = EXCLUDED.psi,
       cgroup = EXCLUDED.cgroup,
       reported_at = EXCLUDED.reported_at,
       updated_at = app_now()`,
    [
      hostId,
      String(pool2.pool_id ?? "osacp.slice/pool.slice"),
      Boolean(pool2.cgroup_available),
      String(pool2.cgroup_driver ?? "cgroupfs"),
      nonNeg(pool2.cpu_total_millicores),
      nonNeg(pool2.mem_total_bytes),
      Math.min(cpuUsed, nonNeg(pool2.cpu_total_millicores) || cpuUsed),
      Math.min(memUsed, nonNeg(pool2.mem_total_bytes) || memUsed),
      workingSet,
      JSON.stringify(pool2.psi ?? {}),
      JSON.stringify(pool2.cgroup ?? {}),
      pool2.reported_at ?? null,
      // The scheduler owns the pressure state machine; a report that omits it must not reset it to NORMAL.
      PRESSURE.has(pressure) ? pressure : null
    ]
  );
  for (const item of instances) {
    const instanceId = String(item.instance_id ?? "").trim();
    if (!instanceId) continue;
    const prev = (await c.query(
      `SELECT usage_cpu_millicores, usage_mem_bytes
           FROM role_instances WHERE instance_id = $1 AND host_id = $2`,
      [instanceId, hostId]
    )).rows[0];
    if (!prev) continue;
    const cpu = smooth(nonNeg(item.cpu_millicores), prev.usage_cpu_millicores);
    const mem = smooth(nonNeg(item.mem_bytes), prev.usage_mem_bytes);
    await c.query(
      `UPDATE role_instances
          SET usage_cpu_millicores = $2, usage_mem_bytes = $3, usage_updated_at = app_now()
        WHERE instance_id = $1`,
      [instanceId, cpu, mem]
    );
    const appliedGeneration = Number(item.applied_generation ?? 0);
    if (Number.isFinite(appliedGeneration) && appliedGeneration > 0) {
      await c.query(
        `UPDATE resource_grants
            SET state = CASE WHEN $3::bigint >= generation THEN 'APPLIED' ELSE 'SUPERSEDED' END,
                applied_generation = $3::bigint,
                applied_cpu_millicores = $4,
                applied_memory_bytes = $5,
                applied_memory_low_bytes = $6,
                applied_memory_high_bytes = $7,
                applied_cpu_weight = $8,
                applied_at = CASE WHEN $3::bigint >= generation THEN app_now() ELSE applied_at END,
                updated_at = app_now()
          WHERE host_id = $1 AND instance_id = $2
            AND $3::bigint >= COALESCE(applied_generation, 0)`,
        [
          hostId,
          instanceId,
          appliedGeneration,
          item.applied_cpu_millicores ?? null,
          item.applied_memory_bytes ?? null,
          item.applied_memory_low_bytes ?? null,
          item.applied_memory_high_bytes ?? null,
          item.applied_cpu_weight ?? null
        ]
      );
    }
  }
}
async function upsertHost(input) {
  const hostId = String(input.host_id ?? "").trim();
  if (!hostId) throw new ApiError(400, "BAD_REQUEST", "host_id is required");
  const raw = String(input.host_state ?? "NORMAL").toUpperCase();
  const hostState = STATES.has(raw) ? raw : "PROTECTING";
  const memTotal = Math.max(0, Math.trunc(Number(input.mem_total_bytes) || 0));
  const memAvailable = Math.min(memTotal, Math.max(0, Math.trunc(Number(input.mem_available_bytes) || 0)));
  const cpuTotal = Math.max(1, Math.trunc(Number(input.cpu_total) || 4));
  await tx(async (c) => {
    await c.query(
      `INSERT INTO hosts
         (host_id, name, os, arch, host_state, cpu_total, mem_total_bytes, mem_available_bytes, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,app_now())
       ON CONFLICT (host_id) DO UPDATE SET
         name = EXCLUDED.name,
         os = EXCLUDED.os,
         arch = EXCLUDED.arch,
         host_state = EXCLUDED.host_state,
         cpu_total = EXCLUDED.cpu_total,
         mem_total_bytes = EXCLUDED.mem_total_bytes,
         mem_available_bytes = EXCLUDED.mem_available_bytes,
         updated_at = app_now()`,
      [
        hostId,
        String(input.name ?? hostId),
        String(input.os ?? "Linux"),
        String(input.arch ?? "-"),
        hostState,
        cpuTotal,
        memTotal,
        memAvailable
      ]
    );
    await c.query(
      `INSERT INTO host_resource_pools
         (host_id, cpu_total_millicores, mem_total_bytes, reported_at, updated_at)
       VALUES ($1,$2,$3,NULL,app_now())
       ON CONFLICT (host_id) DO NOTHING`,
      [hostId, cpuTotal * 1e3, memTotal]
    );
    if (input.resource_pool) await upsertPoolRow(c, hostId, input.resource_pool);
  });
  return { host_id: hostId, host_state: hostState };
}

// scheduler/src/repo/federation.ts
var STALE_CHILD_SECONDS = Math.max(
  90,
  Math.ceil(config.federationIntervalMs / 1e3) * 3
);
function clampScore(value) {
  const n2 = Number(value);
  if (!Number.isFinite(n2) || n2 < 0) return 0;
  return Math.min(1e6, Math.round(n2));
}
function count(value) {
  const n2 = Number(value);
  if (!Number.isFinite(n2) || n2 < 0) return 0;
  return Math.min(1e6, Math.round(n2));
}
function sanitizeUrl(value) {
  const raw = typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString().replace(/\/+$/, "").slice(0, 500);
  } catch {
    return null;
  }
}
var REPORTED_ROLES = /* @__PURE__ */ new Set(["builder", "scheduler"]);
var INSTANCE_LIMIT = 1e3;
function sanitizeInstances(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item;
    const instanceId = String(row.instance_id ?? "").trim();
    const roleId = String(row.role_id ?? "");
    if (!instanceId || !REPORTED_ROLES.has(roleId)) continue;
    out.push({
      instance_id: instanceId.slice(0, 200),
      role_id: roleId,
      host_id: String(row.host_id ?? "").slice(0, 200),
      state: String(row.state ?? "").slice(0, 40),
      capability_score: clampScore(row.capability_score),
      capability_ceiling: clampScore(row.capability_ceiling),
      capability_live: clampScore(row.capability_live)
    });
    if (out.length >= INSTANCE_LIMIT) break;
  }
  return out;
}
async function upsertNodeReport(input) {
  const nodeId = String(input.node_id ?? "").trim();
  const hostId = String(input.host_id ?? "").trim();
  if (!nodeId || !hostId) {
    throw new ApiError(400, "BAD_REQUEST", "node_id / host_id are required");
  }
  const role = input.role === "root" ? "root" : "node";
  const mode = input.mode === "dynamic" ? "dynamic" : input.mode === "static" ? "static" : null;
  const pressure = String(input.pressure_state ?? "").toUpperCase();
  const row = await q1(
    `INSERT INTO scheduler_nodes
       (node_id, parent_node_id, host_id, role, local_score, subtree_score,
        builder_count, child_count, url, max_builder_score, idle_builder_count,
        instances, mode, max_builder_ceiling, max_builder_live, guaranteed_score,
        available_commitment_mem_bytes, pressure_state, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,
             COALESCE($13, 'static'), $14, $15, $16, $17, COALESCE($18, 'NORMAL'), app_now())
     ON CONFLICT (node_id) DO UPDATE SET
       parent_node_id = EXCLUDED.parent_node_id,
       host_id = EXCLUDED.host_id,
       role = EXCLUDED.role,
       local_score = EXCLUDED.local_score,
       subtree_score = EXCLUDED.subtree_score,
       builder_count = EXCLUDED.builder_count,
       child_count = EXCLUDED.child_count,
       url = EXCLUDED.url,
       max_builder_score = EXCLUDED.max_builder_score,
       idle_builder_count = EXCLUDED.idle_builder_count,
       instances = EXCLUDED.instances,
       mode = COALESCE($13, scheduler_nodes.mode),
       max_builder_ceiling = $14,
       max_builder_live = $15,
       guaranteed_score = $16,
       available_commitment_mem_bytes = $17,
       pressure_state = COALESCE($18, scheduler_nodes.pressure_state),
       stale = FALSE,
       updated_at = app_now()
     RETURNING *`,
    [
      nodeId,
      input.parent_node_id ?? null,
      hostId,
      role,
      clampScore(input.local_score),
      clampScore(input.subtree_score),
      count(input.builder_count),
      count(input.child_count),
      sanitizeUrl(input.url),
      clampScore(input.max_builder_score),
      count(input.idle_builder_count),
      JSON.stringify(sanitizeInstances(input.instances)),
      mode,
      clampScore(input.max_builder_ceiling ?? input.max_builder_score),
      clampScore(input.max_builder_live ?? input.max_builder_score),
      clampScore(input.guaranteed_score),
      count(input.available_commitment_mem_bytes),
      ["NORMAL", "BUSY", "PRESSURE", "CRITICAL", "RECOVERING"].includes(pressure) ? pressure : null
    ]
  );
  return row;
}
async function listNodes() {
  return q(
    `SELECT node_id, parent_node_id, host_id, role, local_score, subtree_score,
            builder_count, child_count, url, max_builder_score, idle_builder_count,
            instances, mode, max_builder_ceiling, max_builder_live, guaranteed_score,
            available_commitment_mem_bytes, pressure_state,
            updated_at, EXTRACT(EPOCH FROM (app_now() - updated_at))::int AS age_seconds
       FROM scheduler_nodes
      ORDER BY role DESC, node_id`
  );
}
var PRESSURE_RANK = {
  NORMAL: 0,
  RECOVERING: 1,
  BUSY: 2,
  PRESSURE: 3,
  CRITICAL: 4
};
function worstPressure(states) {
  let worst = "NORMAL";
  for (const state of states) {
    const s = String(state ?? "NORMAL").toUpperCase();
    if ((PRESSURE_RANK[s] ?? 0) > (PRESSURE_RANK[worst] ?? 0)) worst = s;
  }
  return worst;
}
async function capabilitySnapshot(nodeId) {
  const local = await q1(
    `WITH b AS (
       SELECT r.*,
              CASE WHEN r.scheduling_mode = 'dynamic' AND r.capability_ceiling_score > 0
                   THEN r.capability_ceiling_score ELSE r.capability_score END AS eff_ceiling,
              CASE WHEN r.scheduling_mode = 'dynamic' AND r.capability_live_score > 0
                   THEN r.capability_live_score ELSE r.capability_score END AS eff_live,
              CASE WHEN r.scheduling_mode = 'dynamic' AND r.capability_guaranteed_score > 0
                   THEN r.capability_guaranteed_score ELSE r.capability_score END AS eff_guaranteed
         FROM role_instances r
        WHERE r.role_id = 'builder' AND r.state NOT IN ('OFFLINE','FAILED')
     )
     SELECT COALESCE(SUM(capability_score), 0)::int AS score,
            count(*)::int AS n,
            COALESCE(MAX(capability_score), 0)::int AS max_score,
            COALESCE(SUM(eff_ceiling), 0)::int AS ceiling_sum,
            COALESCE(MAX(eff_ceiling), 0)::int AS max_ceiling,
            COALESCE(MAX(eff_live), 0)::int AS max_live,
            COALESCE(SUM(eff_guaranteed), 0)::int AS guaranteed_sum,
            count(*) FILTER (
              WHERE NOT EXISTS (
                SELECT 1 FROM leases l
                 WHERE l.instance_id = b.instance_id
                   AND l.released_at IS NULL AND l.expires_at > app_now()
              )
            )::int AS idle
       FROM b`
  );
  const localInstances = await q(
    `SELECT instance_id, role_id, host_id, state, capability_score,
            CASE WHEN scheduling_mode = 'dynamic' AND capability_ceiling_score > 0
                 THEN capability_ceiling_score ELSE capability_score END AS capability_ceiling,
            CASE WHEN scheduling_mode = 'dynamic' AND capability_live_score > 0
                 THEN capability_live_score ELSE capability_score END AS capability_live
       FROM role_instances
      WHERE role_id IN ('builder','scheduler')
      ORDER BY role_id, instance_id`
  );
  const localPools = await q(
    `SELECT p.available_commitment_bytes, p.pressure_state
       FROM host_resource_pools p
      WHERE EXISTS (
        SELECT 1 FROM role_instances r
         WHERE r.host_id = p.host_id AND r.role_id = 'builder'
           AND r.state NOT IN ('OFFLINE','FAILED')
      )`
  );
  const localAvailable = localPools.reduce(
    (sum, p) => sum + Number(p.available_commitment_bytes ?? 0),
    0
  );
  const localPressure = worstPressure(localPools.map((p) => p.pressure_state));
  const children = await q(
    `SELECT node_id, host_id, role, local_score, subtree_score, builder_count, child_count,
            url, max_builder_score, idle_builder_count, instances,
            mode, max_builder_ceiling, max_builder_live, guaranteed_score,
            available_commitment_mem_bytes, pressure_state,
            EXTRACT(EPOCH FROM (app_now() - updated_at))::int AS age_seconds
       FROM scheduler_nodes
      WHERE parent_node_id = $1
        AND updated_at > app_now() - make_interval(secs => $2)
      ORDER BY node_id`,
    [nodeId, STALE_CHILD_SECONDS]
  );
  const childScore = children.reduce((sum, c) => sum + Number(c.subtree_score ?? 0), 0);
  const childBuilders = children.reduce((sum, c) => sum + Number(c.builder_count ?? 0), 0);
  const childIdle = children.reduce(
    (sum, c) => sum + Number(c.idle_builder_count ?? 0),
    0
  );
  const childMax = children.reduce(
    (max, c) => Math.max(max, Number(c.max_builder_score ?? 0)),
    0
  );
  const childCeiling = children.reduce(
    (max, c) => Math.max(max, Number(c.max_builder_ceiling ?? c.max_builder_score ?? 0)),
    0
  );
  const childLive = children.reduce(
    (max, c) => Math.max(max, Number(c.max_builder_live ?? c.max_builder_score ?? 0)),
    0
  );
  const childGuaranteed = children.reduce(
    (sum, c) => sum + Number(c.guaranteed_score ?? 0),
    0
  );
  const childAvailable = children.reduce(
    (sum, c) => sum + Number(c.available_commitment_mem_bytes ?? 0),
    0
  );
  const childPressure = worstPressure(
    children.map((c) => typeof c.pressure_state === "string" ? c.pressure_state : null)
  );
  const instances = [...localInstances];
  const seen = new Set(instances.map((i) => i.instance_id));
  for (const child of children) {
    for (const item of Array.isArray(child.instances) ? child.instances : []) {
      if (!item?.instance_id || seen.has(item.instance_id)) continue;
      seen.add(item.instance_id);
      instances.push(item);
    }
  }
  return {
    node_id: nodeId,
    mode: config.schedulingMode,
    local_score: Number(local?.score ?? 0),
    builder_count: Number(local?.n ?? 0),
    max_builder_score: Number(local?.max_ceiling ?? local?.max_score ?? 0),
    max_builder_ceiling: Number(local?.max_ceiling ?? 0),
    max_builder_live: Number(local?.max_live ?? 0),
    guaranteed_score: Number(local?.guaranteed_sum ?? 0),
    available_commitment_mem_bytes: localAvailable,
    pressure_state: localPressure,
    idle_builder_count: Number(local?.idle ?? 0),
    subtree_builder_count: Number(local?.n ?? 0) + childBuilders,
    subtree_max_builder_score: Math.max(Number(local?.max_ceiling ?? 0), childCeiling),
    subtree_max_builder_ceiling: Math.max(Number(local?.max_ceiling ?? 0), childCeiling),
    subtree_max_builder_live: Math.max(Number(local?.max_live ?? 0), childLive),
    subtree_guaranteed_score: Number(local?.guaranteed_sum ?? 0) + childGuaranteed,
    subtree_available_commitment_mem_bytes: localAvailable + childAvailable,
    subtree_pressure_state: worstPressure([localPressure, childPressure]),
    subtree_idle_builder_count: Number(local?.idle ?? 0) + childIdle,
    child_score: childScore,
    child_count: children.length,
    subtree_score: Number(local?.score ?? 0) + childScore,
    instances,
    children
  };
}

// scheduler/src/federation-state.ts
var parentUrl = config.parentUrl;
function getFederationParentUrl() {
  return parentUrl;
}
function setFederationParentUrl(value) {
  const next = typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
  parentUrl = next;
  return parentUrl;
}

// scheduler/src/repo/instances.ts
var GIB2 = 1024 ** 3;
var nonNeg2 = (value) => Math.max(0, Math.trunc(Number(value) || 0));
async function register(input) {
  if (!input.instance_id || !input.role_id || !input.host_id) {
    throw new ApiError(400, "BAD_REQUEST", "instance_id / role_id / host_id are required");
  }
  const host = await q1("SELECT host_id FROM hosts WHERE host_id = $1", [input.host_id]);
  if (!host) throw new ApiError(409, "HOST_UNKNOWN", `host not registered: ${input.host_id}`);
  const declared = input.capabilities ?? { healthy: [] };
  const ceiling = [.../* @__PURE__ */ new Set([...declared.healthy ?? [], ...declared.unhealthy ?? []])];
  const detail = input.capability_detail === void 0 ? null : normalizeCapabilityDetail(input.capability_detail);
  const score = input.capability_score !== void 0 ? Math.max(0, Math.min(1e3, Math.round(Number(input.capability_score) || 0))) : detail ? computeCapabilityScore(detail) : null;
  const mode = input.scheduling_mode === "dynamic" ? "dynamic" : input.scheduling_mode === "static" ? "static" : null;
  const capCpu = input.cap_cpu_millicores !== void 0 ? nonNeg2(input.cap_cpu_millicores) : detail?.cores !== void 0 ? Math.round(nonNeg2(detail.cores) * 1e3) : null;
  const capMem = input.cap_mem_bytes !== void 0 ? nonNeg2(input.cap_mem_bytes) : detail?.mem_gb !== void 0 ? Math.round(nonNeg2(detail.mem_gb) * GIB2) : null;
  const split = detail ? splitCapability(detail, {
    cpu_cores: (capCpu ?? Math.round(nonNeg2(detail.cores) * 1e3)) / 1e3,
    mem_gb: (capMem ?? Math.round(nonNeg2(detail.mem_gb) * GIB2)) / GIB2
  }) : null;
  const isDynamic = mode === "dynamic";
  const scoreCeiling = split ? isDynamic ? split.ceiling : score : null;
  const scoreLive = split ? isDynamic ? dynamicLiveScore(split, 1, { scope: "resource" }) : score : null;
  const scoreGuaranteed = split && isDynamic ? dynamicGuaranteedScore(split, {
    cpu_cores: (capCpu ?? 0) / 1e3,
    mem_gb: (capMem ?? 0) / GIB2
  }) : scoreCeiling;
  return tx(async (c) => {
    const res = await c.query(
      `INSERT INTO role_instances (
         instance_id, role_id, host_id, state, agent_profile_id, allowed_task_types,
         capabilities, config_version, protocol_version, payload_schemas,
         capability_ceiling, drain_deadline_at, last_heartbeat_at, updated_at,
         agent_profile_version, api_profile_ids, capability_score, capability_detail,
         scheduling_mode, cap_cpu_millicores, cap_mem_bytes,
         capability_static_score, capability_ceiling_score, capability_live_score,
         capability_dispatch_score, capability_guaranteed_score, capability_updated_at)
       VALUES ($1,$2,$3,'STARTING',$4,$5,$6,$7,$8,COALESCE($9, ARRAY['1.0']),
               $10, NULL, app_now(), app_now(), $11, $12::text[],
               COALESCE($13, 0), COALESCE($14::jsonb, '{}'::jsonb),
               COALESCE($15, 'static'), COALESCE($16, 0), COALESCE($17::bigint, 0),
               COALESCE($18, 0), COALESCE($19, COALESCE($13, 0)), COALESCE($20, COALESCE($13, 0)),
               COALESCE($20, COALESCE($13, 0)), COALESCE($21, COALESCE($19, COALESCE($13, 0))),
               CASE WHEN $13 IS NULL AND $14 IS NULL THEN NULL ELSE app_now() END)
       ON CONFLICT (instance_id) DO UPDATE SET
         role_id = EXCLUDED.role_id,
         host_id = EXCLUDED.host_id,
         agent_profile_id = EXCLUDED.agent_profile_id,
         agent_profile_version = EXCLUDED.agent_profile_version,
         api_profile_ids = EXCLUDED.api_profile_ids,
         allowed_task_types = EXCLUDED.allowed_task_types,
         capabilities = EXCLUDED.capabilities,
         config_version = EXCLUDED.config_version,
         protocol_version = EXCLUDED.protocol_version,
         payload_schemas = EXCLUDED.payload_schemas,
         capability_score = COALESCE($13, role_instances.capability_score),
         capability_detail = COALESCE($14::jsonb, role_instances.capability_detail),
         scheduling_mode = COALESCE($15, role_instances.scheduling_mode),
         cap_cpu_millicores = COALESCE($16, role_instances.cap_cpu_millicores),
         cap_mem_bytes = COALESCE($17::bigint, role_instances.cap_mem_bytes),
         capability_static_score = COALESCE($18, role_instances.capability_static_score),
         capability_ceiling_score = COALESCE($19, role_instances.capability_ceiling_score),
         capability_live_score = COALESCE($20, role_instances.capability_live_score),
         capability_dispatch_score = COALESCE($20, role_instances.capability_dispatch_score),
         capability_guaranteed_score = COALESCE($21, role_instances.capability_guaranteed_score),
         capability_updated_at = CASE WHEN $13 IS NULL AND $14 IS NULL
                                      THEN role_instances.capability_updated_at ELSE app_now() END,
         -- Registration means "a new process has started": the previous process's drain / heartbeat-timeout state is discarded.
         -- Otherwise the DRAINING heartbeat sent when the previous process exits would leave this instance stuck forever.
         state = CASE WHEN role_instances.state IN ('OFFLINE','FAILED','DRAINING','SUSPECT')
                      THEN 'STARTING' ELSE role_instances.state END,
         drain_deadline_at = NULL,
         last_heartbeat_at = app_now(),
         updated_at = app_now()
       RETURNING instance_id, state, config_version, capability_score`,
      [
        input.instance_id,
        input.role_id,
        input.host_id,
        input.agent_profile_id ?? null,
        input.allowed_task_types ?? [],
        JSON.stringify(declared),
        input.config_version ?? 1,
        input.protocol_version ?? "1.0",
        input.payload_schemas ?? null,
        ceiling,
        input.agent_profile_version ?? null,
        input.api_profile_ids ?? [],
        score,
        detail === null ? null : JSON.stringify(detail),
        mode,
        capCpu,
        capMem,
        split?.static_score ?? null,
        scoreCeiling,
        scoreLive,
        scoreGuaranteed
      ]
    );
    return res.rows[0];
  });
}
async function heartbeat(input) {
  const rows = await q(
    `UPDATE role_instances
        SET last_heartbeat_at = app_now(),
            updated_at = app_now(),
            -- Heartbeats must not overwrite an admin-issued DRAINING back to ONLINE; recovery only goes through resume.
            state = CASE
                      WHEN $2::text IS NULL THEN state
                      WHEN state = 'DRAINING' AND $2::text = 'ONLINE' THEN 'DRAINING'
                      ELSE $2::text
                    END,
            load = COALESCE($3, load),
            capabilities = COALESCE($4, capabilities),
            config_version = COALESCE($5, config_version),
            usage_cpu_millicores = COALESCE($6, usage_cpu_millicores),
            usage_mem_bytes = COALESCE($7::bigint, usage_mem_bytes),
            usage_updated_at = CASE WHEN $6 IS NULL AND $7 IS NULL THEN usage_updated_at ELSE app_now() END
      WHERE instance_id = $1
      RETURNING instance_id, state, config_version, host_id`,
    [
      input.instance_id,
      input.state ?? null,
      input.load === void 0 ? null : JSON.stringify(input.load),
      input.capabilities === void 0 ? null : JSON.stringify(input.capabilities),
      input.config_version ?? null,
      input.usage?.cpu_millicores === void 0 ? null : nonNeg2(input.usage.cpu_millicores),
      input.usage?.mem_bytes === void 0 ? null : nonNeg2(input.usage.mem_bytes)
    ]
  );
  if (!rows.length) throw new ApiError(404, "INSTANCE_UNKNOWN", `instance not registered: ${input.instance_id}`);
  const row = rows[0];
  const host = await q1(
    `SELECT host_state FROM hosts WHERE host_id = $1`,
    [row.host_id]
  );
  return {
    instance_id: row.instance_id,
    state: row.state,
    config_version: row.config_version,
    host_id: row.host_id,
    host_state: host?.host_state ?? "UNKNOWN",
    server_time: (/* @__PURE__ */ new Date()).toISOString(),
    pending_commands: 0
  };
}
async function listInstances() {
  return q(
    `SELECT i.*, EXTRACT(EPOCH FROM (app_now() - i.last_heartbeat_at))::int AS heartbeat_age_s
       FROM role_instances i ORDER BY i.instance_id`
  );
}
async function sweepHeartbeats(opts) {
  const suspect = await q(
    `UPDATE role_instances
        SET state = 'SUSPECT', updated_at = app_now()
      WHERE state = 'ONLINE'
        AND last_heartbeat_at IS NOT NULL
        AND last_heartbeat_at < app_now() - make_interval(secs => $1)
      RETURNING instance_id`,
    [opts.suspectAfter]
  );
  const offline = await q(
    `UPDATE role_instances
        SET state = 'OFFLINE', updated_at = app_now()
      WHERE state IN ('ONLINE','SUSPECT')
        AND last_heartbeat_at IS NOT NULL
        AND last_heartbeat_at < app_now() - make_interval(secs => $1)
      RETURNING instance_id`,
    [opts.offlineAfter]
  );
  return {
    suspect: suspect.map((r) => r.instance_id),
    offline: offline.map((r) => r.instance_id)
  };
}
async function setCapabilities(instanceId, input) {
  return tx(async (c) => {
    const inst = (await c.query(`SELECT * FROM role_instances WHERE instance_id = $1 FOR UPDATE`, [instanceId])).rows[0];
    if (!inst) throw new ApiError(404, "INSTANCE_UNKNOWN", `instance not registered: ${instanceId}`);
    const declared = input.declared ?? {};
    const allowed = inst.allowed_task_types ?? [];
    const nextTaskTypes = declared.task_types ?? allowed;
    const extraTypes = nextTaskTypes.filter((t) => !allowed.includes(t));
    if (extraTypes.length) {
      throw new ApiError(403, "CAPABILITY_MISMATCH", "task types can only be narrowed, not expanded", {
        extra: extraTypes,
        allowed
      });
    }
    const current = inst.capabilities ?? {};
    const ceiling = inst.capability_ceiling ?? [
      ...current.healthy ?? [],
      ...current.unhealthy ?? []
    ];
    const nextHealthy = declared.capabilities ?? current.healthy ?? [];
    const extraCaps = nextHealthy.filter((x) => !ceiling.includes(x));
    if (extraCaps.length) {
      throw new ApiError(403, "CAPABILITY_MISMATCH", "capabilities can only be narrowed, not expanded", {
        extra: extraCaps,
        ceiling
      });
    }
    const nextCaps = {
      healthy: nextHealthy,
      unhealthy: (current.unhealthy ?? []).filter((x) => nextHealthy.includes(x))
    };
    const row = (await c.query(
      `UPDATE role_instances
            SET capabilities = $2::jsonb, allowed_task_types = $3,
                config_version = COALESCE($4, config_version), updated_at = app_now()
          WHERE instance_id = $1
          RETURNING instance_id, state, capabilities, allowed_task_types, config_version`,
      [instanceId, JSON.stringify(nextCaps), nextTaskTypes, input.config_version ?? null]
    )).rows[0];
    return {
      instance_id: row.instance_id,
      state: row.state,
      capabilities: row.capabilities,
      allowed_task_types: row.allowed_task_types,
      config_version: row.config_version
    };
  });
}
async function drain(instanceId, input = {}) {
  const seconds = Number(input.timeout_seconds ?? 300);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new ApiError(400, "BAD_REQUEST", "timeout_seconds must be positive");
  }
  return tx(async (c) => {
    const inst = (await c.query(`SELECT * FROM role_instances WHERE instance_id = $1 FOR UPDATE`, [instanceId])).rows[0];
    if (!inst) throw new ApiError(404, "INSTANCE_UNKNOWN", `instance not registered: ${instanceId}`);
    if (!["ONLINE", "SUSPECT", "DRAINING"].includes(inst.state)) {
      throw new ApiError(409, "INSTANCE_NOT_ELIGIBLE", `instance state is ${inst.state}; cannot drain`);
    }
    const row = (await c.query(
      `UPDATE role_instances
            SET state = 'DRAINING',
                drain_deadline_at = COALESCE(drain_deadline_at,
                                             app_now() + make_interval(secs => $2)),
                updated_at = app_now()
          WHERE instance_id = $1
          RETURNING instance_id, state, drain_deadline_at`,
      [instanceId, seconds]
    )).rows[0];
    const active = await c.query(
      `SELECT count(*)::int AS n FROM leases
        WHERE instance_id = $1 AND released_at IS NULL AND expires_at > app_now()`,
      [instanceId]
    );
    return {
      instance_id: row.instance_id,
      state: row.state,
      drain_deadline_at: row.drain_deadline_at,
      reason: input.reason ?? null,
      active_attempts: active.rows[0].n
    };
  });
}
async function resume(instanceId) {
  return tx(async (c) => {
    const inst = (await c.query(`SELECT * FROM role_instances WHERE instance_id = $1 FOR UPDATE`, [instanceId])).rows[0];
    if (!inst) throw new ApiError(404, "INSTANCE_UNKNOWN", `instance not registered: ${instanceId}`);
    if (inst.state === "ONLINE") return { instance_id: instanceId, state: "ONLINE", idempotent: true };
    if (inst.state !== "DRAINING") {
      throw new ApiError(409, "STATE_CONFLICT", `instance state is ${inst.state}; cannot resume`);
    }
    const row = (await c.query(
      `UPDATE role_instances
            SET state = 'ONLINE', drain_deadline_at = NULL, updated_at = app_now()
          WHERE instance_id = $1
          RETURNING instance_id, state`,
      [instanceId]
    )).rows[0];
    return { instance_id: row.instance_id, state: row.state };
  });
}
async function deregister(instanceId, input = {}) {
  return tx(async (c) => {
    const inst = (await c.query(`SELECT * FROM role_instances WHERE instance_id = $1 FOR UPDATE`, [instanceId])).rows[0];
    if (!inst) throw new ApiError(404, "INSTANCE_UNKNOWN", `instance not registered: ${instanceId}`);
    const active = await c.query(
      `SELECT count(*)::int AS n FROM leases
        WHERE instance_id = $1 AND released_at IS NULL AND expires_at > app_now()`,
      [instanceId]
    );
    const activeAttempts = active.rows[0].n;
    if (activeAttempts > 0 && !input.force) {
      throw new ApiError(409, "STATE_CONFLICT", "there are still in-flight tasks; cannot deregister", {
        active_attempts: activeAttempts
      });
    }
    await c.query(
      `UPDATE role_instances
          SET state = 'OFFLINE', drain_deadline_at = NULL, updated_at = app_now()
        WHERE instance_id = $1`,
      [instanceId]
    );
    return {
      instance_id: instanceId,
      state: "OFFLINE",
      active_attempts: activeAttempts,
      reason: input.reason ?? null
    };
  });
}
async function forget(instanceId) {
  return tx(async (c) => {
    const inst = (await c.query(`SELECT * FROM role_instances WHERE instance_id = $1 FOR UPDATE`, [instanceId])).rows[0];
    if (!inst) throw new ApiError(404, "INSTANCE_UNKNOWN", `instance not registered: ${instanceId}`);
    const active = await c.query(
      `SELECT count(*)::int AS n FROM leases
        WHERE instance_id = $1 AND released_at IS NULL AND expires_at > app_now()`,
      [instanceId]
    );
    const activeAttempts = active.rows[0].n;
    if (activeAttempts > 0) {
      throw new ApiError(409, "STATE_CONFLICT", "there are still in-flight tasks; cannot forget the instance", {
        active_attempts: activeAttempts
      });
    }
    if (inst.state !== "OFFLINE" && inst.state !== "FAILED") {
      throw new ApiError(
        409,
        "INSTANCE_ALIVE",
        `instance is ${inst.state}; remove its deployment, or wait for it to go offline`,
        { state: inst.state }
      );
    }
    await c.query(`DELETE FROM role_instances WHERE instance_id = $1`, [instanceId]);
    return { instance_id: instanceId, state: inst.state, forgotten: true };
  });
}
async function syncConfig(instanceId, version) {
  const inst = await q1(`SELECT * FROM role_instances WHERE instance_id = $1`, [instanceId]);
  if (!inst) throw new ApiError(404, "INSTANCE_UNKNOWN", `instance not registered: ${instanceId}`);
  const current = Number(inst.config_version);
  if (version !== void 0 && version !== null && Number(version) === current) return null;
  const cfg = await q1(`SELECT * FROM scheduler_config WHERE id = TRUE`);
  return {
    config_version: current,
    agent: {
      profile_id: inst.agent_profile_id,
      version: inst.agent_profile_version,
      args: {}
    },
    api_profiles: inst.api_profile_ids ?? [],
    resource_profile: null,
    scheduling_mode: inst.scheduling_mode ?? "static",
    capacity: {
      cap_cpu_millicores: Number(inst.cap_cpu_millicores ?? 0),
      cap_mem_bytes: Number(inst.cap_mem_bytes ?? 0)
    },
    capability: {
      schema_version: Number(inst.capability_schema_version ?? 1),
      static_score: Number(inst.capability_static_score ?? 0),
      ceiling: Number(inst.capability_ceiling_score ?? inst.capability_score ?? 0),
      live: Number(inst.capability_live_score ?? inst.capability_score ?? 0),
      dispatch: Number(inst.capability_dispatch_score ?? inst.capability_score ?? 0),
      guaranteed: Number(inst.capability_guaranteed_score ?? inst.capability_score ?? 0)
    },
    allowed_task_types: inst.allowed_task_types,
    capabilities: inst.capabilities,
    drain: {
      requested: inst.state === "DRAINING",
      deadline_at: inst.drain_deadline_at
    },
    policy: {
      heartbeat_interval_seconds: 10,
      suspect_after_seconds: cfg.suspect_after_seconds,
      offline_after_seconds: cfg.offline_after_seconds,
      lease_seconds: cfg.lease_seconds
    }
  };
}
async function sweepDrainTimeouts() {
  const rows = await q(
    `UPDATE role_instances
        SET state = 'OFFLINE', drain_deadline_at = NULL, updated_at = app_now()
      WHERE state = 'DRAINING'
        AND drain_deadline_at IS NOT NULL
        AND drain_deadline_at <= app_now()
      RETURNING instance_id`
  );
  return rows.map((r) => String(r.instance_id));
}

// scheduler/src/http/server.ts
function bodyAs(body) {
  return body;
}
var NOT_MODIFIED = /* @__PURE__ */ Symbol("NOT_MODIFIED");
var routes = [];
function route(method, pattern, handler, opts = {}) {
  const keys = [];
  const re = new RegExp(
    "^" + pattern.replace(/:([a-zA-Z_]+)/g, (_, k) => {
      keys.push(k);
      return "([^/]+)";
    }) + "/?$"
  );
  const auth = opts.auth === true ? "instance" : opts.auth === false ? "none" : opts.auth ?? "none";
  routes.push({ method, re, keys, handler, auth, scopes: opts.scopes ?? [] });
}
route(
  "POST",
  "/v1/instances/register",
  (c) => {
    assertSelf(c.auth, String(c.body.instance_id ?? ""));
    return register(bodyAs(c.body));
  },
  { auth: true, scopes: ["instance:register"] }
);
route(
  "POST",
  "/v1/instances/heartbeat",
  (c) => {
    assertSelf(c.auth, String(c.body.instance_id ?? ""));
    return heartbeat(bodyAs(c.body));
  },
  { auth: true, scopes: ["instance:claim"] }
);
route("GET", "/v1/instances", async () => ({ items: await listInstances() }));
route("POST", "/v1/hosts", (c) => upsertHost(bodyAs(c.body)));
route(
  "PUT",
  "/v1/instances/:id/capabilities",
  (c) => {
    assertSelf(c.auth, c.params.id);
    return setCapabilities(c.params.id, bodyAs(c.body));
  },
  { auth: true, scopes: ["instance:register"] }
);
route(
  "POST",
  "/v1/instances/:id/drain",
  (c) => {
    assertSelf(c.auth, c.params.id);
    return drain(c.params.id, bodyAs(c.body));
  },
  { auth: true, scopes: ["instance:register"] }
);
route(
  "POST",
  "/v1/instances/:id/resume",
  (c) => {
    assertSelf(c.auth, c.params.id);
    return resume(c.params.id);
  },
  { auth: true, scopes: ["instance:register"] }
);
route(
  "POST",
  "/v1/instances/:id/deregister",
  (c) => {
    assertSelf(c.auth, c.params.id);
    return deregister(c.params.id, bodyAs(c.body));
  },
  { auth: true, scopes: ["instance:register"] }
);
route("DELETE", "/v1/instances/:id", (c) => forget(c.params.id));
route(
  "GET",
  "/v1/instances/:id/config",
  async (c) => {
    assertSelf(c.auth, c.params.id);
    const raw = c.query.get("version");
    const version = raw === null ? null : Number(raw);
    if (version !== null && !Number.isFinite(version)) {
      throw new ApiError(400, "BAD_REQUEST", "version must be a number");
    }
    const cfg = await syncConfig(c.params.id, version);
    return cfg ?? NOT_MODIFIED;
  },
  { auth: true, scopes: ["config:read"] }
);
route(
  "GET",
  "/v1/instances/:id/grant",
  async (c) => {
    assertSelf(c.auth, c.params.id);
    const state = await getInstanceGrantState(c.params.id);
    if (!state) throw new ApiError(404, "INSTANCE_UNKNOWN", `instance not registered: ${c.params.id}`);
    return state;
  },
  { auth: true, scopes: ["instance:claim"] }
);
route(
  "POST",
  "/v1/instances/:id/grant/applied",
  async (c) => {
    assertSelf(c.auth, c.params.id);
    const state = await getInstanceGrantState(c.params.id);
    if (!state) throw new ApiError(404, "INSTANCE_UNKNOWN", `instance not registered: ${c.params.id}`);
    const generation = Number(c.body?.generation);
    if (!Number.isFinite(generation) || generation <= 0) {
      throw new ApiError(400, "BAD_REQUEST", "generation must be a positive integer");
    }
    const error = typeof c.body?.error === "string" ? c.body.error.trim() : "";
    if (error) {
      await markGrantFailed({
        host_id: state.host_id,
        instance_id: c.params.id,
        generation,
        error
      });
      return { ok: false, state: "FAILED" };
    }
    const applied = bodyAs(c.body);
    return markGrantApplied({
      host_id: state.host_id,
      instance_id: c.params.id,
      generation,
      cpu_millicores: applied.cpu_millicores,
      memory_bytes: applied.memory_bytes,
      memory_low_bytes: applied.memory_low_bytes,
      memory_high_bytes: applied.memory_high_bytes,
      cpu_weight: applied.cpu_weight
    });
  },
  { auth: true, scopes: ["instance:claim"] }
);
route("GET", "/v1/hosts/:id/resource-grants", async (c) => ({
  host_id: c.params.id,
  items: await getGrants(c.params.id)
}));
route(
  "POST",
  "/v1/claim",
  async (c) => {
    assertSelf(c.auth, String(c.body.instance_id ?? ""));
    const a = await claim(bodyAs(c.body));
    if (!a) return { noop: true };
    return a;
  },
  { auth: true, scopes: ["instance:claim"] }
);
var proof = (c) => bodyAs({ ...c.body, auth_instance_id: c.auth?.instance_id ?? void 0 });
route("POST", "/v1/attempts/:id/start-ack", (c) => startAck(c.params.id, proof(c)), {
  auth: true,
  scopes: ["task:report"]
});
route("POST", "/v1/attempts/:id/renew", (c) => renew(c.params.id, proof(c)), {
  auth: true,
  scopes: ["task:report"]
});
route("POST", "/v1/attempts/:id/progress", (c) => progress(c.params.id, proof(c)), {
  auth: true,
  scopes: ["task:report"]
});
route("POST", "/v1/attempts/:id/result", (c) => submitResult(
  c.params.id,
  bodyAs({ ...c.body, auth_instance_id: c.auth?.instance_id ?? void 0 })
), {
  auth: true,
  scopes: ["task:report"]
});
route(
  "POST",
  "/v1/tasks/:id/split",
  (c) => splitTask(
    c.params.id,
    proof(c),
    bodyAs(c.body).children ?? []
  ),
  {
    auth: true,
    scopes: ["task:report"]
  }
);
route(
  "POST",
  "/v1/tasks/:id/answer",
  (c) => answerTask(
    c.params.id,
    String(bodyAs(c.body).answer ?? ""),
    String(c.body.actor ?? "operator")
  )
);
route("POST", "/v1/tasks", async (c) => {
  const input = bodyAs(c.body);
  const task = await createTask(input);
  const relayed = await maybeRelayTask(task, input);
  return relayed ? { ...task, relay: relayed } : task;
});
route("GET", "/v1/tasks", async (c) => ({
  items: await listTasks({
    status: c.query.get("status") ?? void 0,
    task_type: c.query.get("task_type") ?? void 0,
    role: c.query.get("role") ?? void 0,
    limit: c.query.get("limit") ? Number(c.query.get("limit")) : void 0
  })
}));
route("GET", "/v1/failure-signatures", async (c) => ({
  items: await listFailureSignatures(c.query.get("limit") ? Number(c.query.get("limit")) : void 0)
}));
route("GET", "/v1/tasks/:id", (c) => getTask(c.params.id));
route("GET", "/v1/tasks/:id/events", async (c) => ({ items: await listEvents(c.params.id) }));
route("GET", "/v1/events", async (c) => {
  const after = Number(c.query.get("after") ?? 0);
  const limit = c.query.get("limit") ? Number(c.query.get("limit")) : void 0;
  if (!Number.isFinite(after) || after < 0) {
    throw new ApiError(400, "BAD_REQUEST", "after must be a non-negative integer");
  }
  const items = await listOutbox(after, limit);
  return { items, next_after: items.length ? Number(items[items.length - 1].event_id) : after };
});
route("POST", "/v1/tasks/:id/cancel", async (c) => {
  const out = await cancelTask(c.params.id, String(c.body.actor ?? "operator"));
  await requestRelayCancel(c.params.id);
  return out;
});
route(
  "POST",
  "/v1/tasks/:id/retry",
  (c) => retryTask(c.params.id, String(c.body.actor ?? "operator"))
);
route(
  "POST",
  "/v1/artifacts",
  (c) => createArtifact(bodyAs(c.body), c.auth?.instance_id ?? String(c.body.instance_id ?? "")),
  { auth: true, scopes: ["artifact:write"] }
);
route(
  "POST",
  "/v1/artifacts/:id/complete",
  (c) => completeArtifact(c.params.id, c.auth?.instance_id ?? void 0),
  { auth: true, scopes: ["artifact:write"] }
);
route(
  "GET",
  "/v1/artifacts/:id",
  async (c) => {
    const row = await getArtifact(c.params.id);
    assertSelf(c.auth, row.instance_id);
    return row;
  },
  { auth: true, scopes: ["artifact:read"] }
);
route("GET", "/v1/tasks/:id/artifacts", (c) => listTaskArtifacts(c.params.id));
route("POST", "/v1/workflows", (c) => createWorkflowRun(bodyAs(c.body)));
route("GET", "/v1/workflows", async (c) => ({
  items: await listWorkflowRuns(c.query.get("limit") ? Number(c.query.get("limit")) : void 0)
}));
route("GET", "/v1/approvals", async (c) => ({
  items: await listApprovalRequests({
    status: c.query.get("status") ?? void 0,
    limit: c.query.get("limit") ? Number(c.query.get("limit")) : void 0
  })
}));
route("GET", "/v1/task-definitions", async () => ({
  items: await q(
    `SELECT task_type, task_version, target_role, capabilities, max_attempts
       FROM task_definitions ORDER BY target_role, task_type`
  )
}));
route("GET", "/v1/workflows/:id", (c) => getWorkflowRun(c.params.id));
route(
  "POST",
  "/v1/tasks/:id/approve",
  (c) => decideApproval(
    bodyAs({ ...c.body, task_id: c.params.id })
  )
);
route("GET", "/v1/capability", async () => capabilitySnapshot(selfNodeId()));
route("GET", "/v1/nodes", async () => ({
  self: await capabilitySnapshot(selfNodeId()),
  items: await listNodes()
}));
route("POST", "/v1/nodes/report", (c) => {
  if (!config.federationToken) {
    throw new ApiError(503, "FEDERATION_DISABLED", "SCHEDULER_FEDERATION_TOKEN is not configured");
  }
  const raw = c.headers["x-federation-token"];
  const token = Array.isArray(raw) ? raw[0] : raw;
  if (token !== config.federationToken) {
    throw new ApiError(401, "FEDERATION_TOKEN_INVALID", "node report token is invalid");
  }
  return upsertNodeReport(
    bodyAs({ ...c.body, parent_node_id: selfNodeId(), role: "node" })
  );
});
route("GET", "/v1/federation/parent", async () => ({
  parent_url: getFederationParentUrl() || null
}));
route("POST", "/v1/federation/parent", async (c) => {
  if (!config.federationToken) {
    throw new ApiError(503, "FEDERATION_DISABLED", "SCHEDULER_FEDERATION_TOKEN is not configured");
  }
  const raw = c.headers["x-federation-token"];
  const token = Array.isArray(raw) ? raw[0] : raw;
  if (token !== config.federationToken) {
    throw new ApiError(401, "FEDERATION_TOKEN_INVALID", "federation token is invalid");
  }
  return { parent_url: setFederationParentUrl(c.body?.parent_url) || null };
});
route("GET", "/healthz", async () => ({ ok: true }));
route("GET", "/readyz", async () => {
  const db = await q1("SELECT 1 AS ok");
  const migrated = await q1(
    "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'tasks'"
  );
  const ready = !!db && migrated?.n === 1;
  if (!ready) throw new ApiError(503, "NOT_READY", "database or schema is not ready");
  return { ready: true };
});
route("GET", "/v1/queue/stats", async () => {
  const byStatus = await q(
    `SELECT status, count(*)::int AS n,
            COALESCE(max(EXTRACT(EPOCH FROM (app_now() - enqueued_at)))::int, 0) AS oldest_wait_s
       FROM tasks GROUP BY status`
  );
  const instances = await q(
    `SELECT state, count(*)::int AS n FROM role_instances GROUP BY state`
  );
  const leases = await q1(
    `SELECT count(*)::int AS n FROM leases WHERE released_at IS NULL AND expires_at > app_now()`
  );
  return { tasks: byStatus, instances, active_leases: leases?.n ?? 0 };
});
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function streamEvents(req, res, url) {
  const header = req.headers["last-event-id"];
  const raw = (Array.isArray(header) ? header[0] : header) ?? url.searchParams.get("after");
  let cursor = raw !== void 0 && raw !== null && raw !== "" ? Number(raw) : await latestEventId();
  if (!Number.isFinite(cursor) || cursor < 0) cursor = await latestEventId();
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });
  res.write(`: connected, from ${cursor}

`);
  let closed = false;
  req.on("close", () => {
    closed = true;
  });
  let lastPing = Date.now();
  while (!closed) {
    try {
      const items = await listOutbox(cursor, 200);
      for (const e of items) {
        if (closed) break;
        const id = Number(e.event_id);
        res.write(`id: ${id}
event: ${e.event_type}
data: ${JSON.stringify(e)}

`);
        cursor = id;
      }
    } catch (err) {
      if (!closed) console.error("[sse]", err);
    }
    if (!closed && Date.now() - lastPing > 15e3) {
      res.write(`: ping

`);
      lastPing = Date.now();
    }
    if (!closed) await sleep(500);
  }
  res.end();
}
function readRawBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new ApiError(413, "PAYLOAD_TOO_LARGE", `request body exceeds ${limit} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        reject(new ApiError(413, "PAYLOAD_TOO_LARGE", "request body exceeds 2MB"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new ApiError(400, "BAD_JSON", "request body is not valid JSON"));
      }
    });
    req.on("error", reject);
  });
}
function send(res, status, payload, noContent = false) {
  if (noContent) {
    res.writeHead(status);
    res.end();
    return;
  }
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}
var ADMIN_ORIGINS = (process.env.ADMIN_ORIGINS ?? "http://127.0.0.1:5173,http://localhost:5173,tauri://localhost,http://tauri.localhost").split(",").map((s) => s.trim()).filter(Boolean);
function createServer() {
  const handler = async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const started = performance.now();
    const origin = req.headers.origin;
    if (origin && ADMIN_ORIGINS.includes(origin)) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("vary", "origin");
      res.setHeader("access-control-allow-methods", "GET,POST,PUT,DELETE,OPTIONS");
      res.setHeader("access-control-allow-headers", "authorization,content-type,last-event-id");
      res.setHeader("access-control-max-age", "600");
    }
    if (req.method === "OPTIONS") {
      res.writeHead(origin && ADMIN_ORIGINS.includes(origin) ? 204 : 403);
      res.end();
      return;
    }
    try {
      if (req.method === "GET" && url.pathname === "/v1/events/stream") {
        await streamEvents(req, res, url);
        return;
      }
      const contentMatch = /^\/v1\/artifacts\/([^/]+)\/content$/.exec(url.pathname);
      if (contentMatch && req.method === "PUT") {
        const auth2 = requireInstanceAuth(req);
        if (auth2?.kind === "jwt" && auth2.claims) requireScope(auth2.claims, "artifact:write");
        const data = await readRawBody(req, 64 * 1024 * 1024);
        const out2 = await putArtifactContent(
          decodeURIComponent(contentMatch[1]),
          data,
          auth2?.instance_id ?? void 0
        );
        send(res, 200, out2);
        return;
      }
      if (contentMatch && req.method === "GET") {
        const auth2 = requireInstanceAuth(req);
        if (auth2?.kind === "jwt" && auth2.claims) requireScope(auth2.claims, "artifact:read");
        const out2 = await readArtifactContent(
          decodeURIComponent(contentMatch[1]),
          auth2?.instance_id ?? void 0
        );
        res.writeHead(200, {
          "content-type": out2.media_type,
          "content-length": String(out2.data.length),
          "x-artifact-sha256": out2.sha256 ?? "",
          "cache-control": "no-store"
        });
        res.end(out2.data);
        return;
      }
      const downloadMatch = /^\/v1\/artifacts\/([^/]+)\/download$/.exec(url.pathname);
      if (downloadMatch && req.method === "GET") {
        const out2 = await readArtifactContent(decodeURIComponent(downloadMatch[1]), void 0);
        const filename = downloadFilename(out2);
        const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
        res.writeHead(200, {
          "content-type": out2.media_type,
          "content-length": String(out2.data.length),
          "content-disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
          "x-artifact-sha256": out2.sha256 ?? "",
          "x-artifact-name": encodeURIComponent(filename),
          "cache-control": "no-store"
        });
        res.end(out2.data);
        return;
      }
      const matched = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
      if (!matched) throw new ApiError(404, "ROUTE_NOT_FOUND", `${req.method} ${url.pathname}`);
      const m = url.pathname.match(matched.re);
      const params = {};
      matched.keys.forEach((k, i) => params[k] = decodeURIComponent(m[i + 1]));
      const auth = matched.auth === "instance" ? requireInstanceAuth(req) : null;
      if (auth?.kind === "jwt" && auth.claims) {
        for (const scope of matched.scopes) requireScope(auth.claims, scope);
      }
      const body = req.method === "GET" ? {} : await readBody(req);
      const out = await matched.handler({
        params,
        body,
        query: url.searchParams,
        auth,
        headers: req.headers
      });
      if (out === NOT_MODIFIED) {
        res.writeHead(304);
        res.end();
      } else if (out && typeof out === "object" && out.noop) {
        send(res, 204, null, true);
      } else {
        send(res, 200, out);
      }
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError(500, "INTERNAL", e instanceof Error ? e.message : String(e));
      if (err.status >= 500) console.error("[5xx]", err.code, err.message);
      send(res, err.status, {
        error: { code: err.code, message: err.message, detail: err.detail ?? null }
      });
    } finally {
      const ms = (performance.now() - started).toFixed(1);
      if (url.pathname !== "/healthz") {
        console.log(`${req.method} ${url.pathname} ${res.statusCode} ${ms}ms`);
      }
    }
  };
  if (!config.tlsCertFile) return http.createServer(handler);
  const options = {
    cert: fs3.readFileSync(config.tlsCertFile),
    key: fs3.readFileSync(config.tlsKeyFile)
  };
  if (config.tlsCaFile) options.ca = fs3.readFileSync(config.tlsCaFile);
  if (config.mtls) {
    options.requestCert = true;
    options.rejectUnauthorized = true;
  }
  return https.createServer(options, handler);
}

// scheduler/src/loops/reaper.ts
async function sweepLeases(limit = 50) {
  return tx(async (c) => {
    const cfg = (await c.query("SELECT * FROM scheduler_config WHERE id = TRUE")).rows[0];
    const rows = (await c.query(
      `SELECT l.lease_token, l.task_id, l.attempt_id, l.instance_id, l.issued_at, l.expires_at,
                (l.expires_at <= app_now()) AS expired,
                t.status AS task_status, t.attempt_count, t.max_attempts, t.fanout_id,
                a.status AS attempt_status, a.outward_actions
           FROM leases l
           JOIN tasks t ON t.task_id = l.task_id
           JOIN task_attempts a ON a.attempt_id = l.attempt_id
          WHERE l.released_at IS NULL
            AND (
              l.expires_at <= app_now()
              OR (t.status = 'ASSIGNED'
                  AND l.issued_at <= app_now() - make_interval(secs => $1))
            )
          ORDER BY l.issued_at
          FOR UPDATE OF l SKIP LOCKED
          LIMIT $2`,
      [cfg.start_window_seconds, limit]
    )).rows;
    const out = [];
    for (const row of rows) {
      const cause = row.task_status === "ASSIGNED" && !row.expired ? "START_TIMEOUT" : "LEASE_EXPIRED";
      await c.query(
        `UPDATE leases SET released_at = app_now(), release_reason = $2
          WHERE lease_token = $1`,
        [row.lease_token, cause]
      );
      await c.query(
        `UPDATE resource_reservations
            SET state = 'RECLAIMED', closed_at = app_now(), close_reason = $2
          WHERE attempt_id = $1 AND state IN ('HELD','ACTIVE')`,
        [row.attempt_id, cause]
      );
      if (!["SUCCEEDED", "FAILED", "CANCELLED", "TIMEOUT", "PARKED"].includes(row.attempt_status)) {
        await c.query(
          `UPDATE task_attempts SET status = 'TIMEOUT', finished_at = app_now(),
                                    error = $2
            WHERE attempt_id = $1`,
          [row.attempt_id, JSON.stringify({ code: cause })]
        );
      }
      const outward = Array.isArray(row.outward_actions) ? row.outward_actions : [];
      if (outward.length > 0) {
        await c.query(
          `UPDATE tasks SET status = 'FAILED', outcome = 'interrupted_after_outward',
                            current_attempt_id = NULL, dead_letter = TRUE,
                            version = version + 1, updated_at = app_now()
            WHERE task_id = $1`,
          [row.task_id]
        );
        await appendEvent(c, {
          task_id: row.task_id,
          event_type: "TASK_DEAD_LETTERED",
          from_status: row.task_status,
          to_status: "FAILED",
          actor: "scheduler",
          payload: {
            attempt_id: row.attempt_id,
            cause,
            error_code: "INTERRUPTED_AFTER_OUTWARD_ACTION",
            outcome: "interrupted_after_outward",
            outward_actions: outward,
            non_retryable: true,
            alert: "P1"
          }
        });
        await settleFanout(c, { task_id: row.task_id, fanout_id: row.fanout_id });
        out.push({ task_id: row.task_id, cause, to: "FAILED" });
        continue;
      }
      if (row.attempt_count >= row.max_attempts) {
        await c.query(
          `UPDATE tasks SET status = 'FAILED', outcome = 'error', current_attempt_id = NULL,
                            dead_letter = TRUE, version = version + 1, updated_at = app_now()
            WHERE task_id = $1`,
          [row.task_id]
        );
        await appendEvent(c, {
          task_id: row.task_id,
          event_type: "TASK_DEAD_LETTERED",
          from_status: row.task_status,
          to_status: "FAILED",
          actor: "scheduler",
          payload: { attempt_id: row.attempt_id, cause, outcome: "error", alert: "P1" }
        });
        await settleFanout(c, { task_id: row.task_id, fanout_id: row.fanout_id });
        out.push({ task_id: row.task_id, cause, to: "FAILED" });
      } else {
        await c.query(
          `UPDATE tasks
              SET status = 'QUEUED', current_attempt_id = NULL,
                  next_attempt_at = app_now() + make_interval(secs => $2),
                  version = version + 1, updated_at = app_now()
            WHERE task_id = $1`,
          [row.task_id, backoffSeconds2(cfg.retry_backoff_seconds, row.attempt_count)]
        );
        await appendEvent(c, {
          task_id: row.task_id,
          event_type: "TASK_RECLAIMED",
          from_status: row.task_status,
          to_status: "QUEUED",
          actor: "scheduler",
          payload: {
            attempt_id: row.attempt_id,
            cause,
            attempt_count: row.attempt_count,
            max_attempts: row.max_attempts,
            backoff_seconds: backoffSeconds2(cfg.retry_backoff_seconds, row.attempt_count)
          }
        });
        out.push({ task_id: row.task_id, cause, to: "QUEUED" });
      }
    }
    return { reclaimed: out };
  });
}
async function sweepNeedsInput(limit = 50) {
  return tx(async (c) => {
    const rows = (await c.query(
      `SELECT task_id, fanout_id, pending_question, needs_input_at
           FROM tasks
          WHERE status = 'NEEDS_INPUT'
            AND needs_input_expires_at IS NOT NULL
            AND needs_input_expires_at <= app_now()
          ORDER BY needs_input_expires_at
          FOR UPDATE SKIP LOCKED
          LIMIT $1`,
      [limit]
    )).rows;
    const expired = [];
    for (const row of rows) {
      await c.query(
        `UPDATE tasks SET status = 'FAILED', outcome = 'input_expired', dead_letter = TRUE,
                          current_attempt_id = NULL, version = version + 1, updated_at = app_now()
          WHERE task_id = $1`,
        [row.task_id]
      );
      await appendEvent(c, {
        task_id: row.task_id,
        event_type: "TASK_INPUT_EXPIRED",
        from_status: "NEEDS_INPUT",
        to_status: "FAILED",
        actor: "scheduler",
        payload: {
          outcome: "input_expired",
          question_chars: row.pending_question?.question ? String(row.pending_question.question).length : 0,
          asked_at: row.needs_input_at
        }
      });
      await settleFanout(c, { task_id: row.task_id, fanout_id: row.fanout_id });
      expired.push(row.task_id);
    }
    return { expired };
  });
}

// scheduler/src/main.ts
var server = createServer();
async function readTuning() {
  const res = await pool.query("SELECT * FROM scheduler_config WHERE id = TRUE");
  return res.rows[0];
}
var timer;
var running = false;
var federationTimer;
var relayTimer;
var reporting = false;
var syncingRelays = false;
var grantTimer;
var granting = false;
async function tick() {
  if (running) return;
  running = true;
  try {
    const cfg = await readTuning();
    const hb = await sweepHeartbeats({
      suspectAfter: cfg.suspect_after_seconds,
      offlineAfter: cfg.offline_after_seconds
    });
    if (hb.suspect.length) console.log("[heartbeat] SUSPECT", hb.suspect.join(","));
    if (hb.offline.length) console.log("[heartbeat] OFFLINE", hb.offline.join(","));
    const drainedOut = await sweepDrainTimeouts();
    if (drainedOut.length) console.log("[drain] timed out; OFFLINE", drainedOut.join(","));
    const r = await sweepLeases();
    if (r.reclaimed.length) {
      console.log(
        "[lease] reclaimed",
        r.reclaimed.map((x) => `${x.task_id}:${x.cause}->${x.to}`).join(" ")
      );
    }
    const ni = await sweepNeedsInput();
    if (ni.expired.length) console.log("[input] expired questions", ni.expired.join(","));
  } catch (e) {
    console.error("[tick]", e);
  } finally {
    running = false;
  }
}
async function reportUpstream() {
  const parentUrl2 = getFederationParentUrl();
  if (!parentUrl2 || !config.federationToken) return;
  if (reporting) return;
  reporting = true;
  try {
    const snap = await capabilitySnapshot(selfNodeId());
    const res = await fetch(`${parentUrl2}/v1/nodes/report`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-federation-token": config.federationToken
      },
      body: JSON.stringify({
        node_id: snap.node_id,
        host_id: config.hostId || snap.node_id,
        local_score: snap.local_score,
        subtree_score: snap.subtree_score,
        // Capacity metrics report whole-subtree values: an intermediate node may have no builders itself, but its subtree does.
        builder_count: snap.subtree_builder_count,
        child_count: snap.child_count,
        // The parent needs for relaying: reachable address, max W, idle count, subtree instance roster.
        url: config.advertiseUrl || null,
        max_builder_score: snap.subtree_max_builder_score,
        mode: snap.mode,
        // Cross-mode eligibility uses the ceiling; live is only for same-mode ordering (§12.3).
        max_builder_ceiling: snap.subtree_max_builder_ceiling,
        max_builder_live: snap.subtree_max_builder_live,
        guaranteed_score: snap.subtree_guaranteed_score,
        available_commitment_mem_bytes: snap.subtree_available_commitment_mem_bytes,
        pressure_state: snap.subtree_pressure_state,
        idle_builder_count: snap.subtree_idle_builder_count,
        instances: snap.instances
      }),
      signal: AbortSignal.timeout(8e3)
    });
    if (!res.ok) {
      console.warn(`[federation] Report failed ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
  } catch (e) {
    console.warn("[federation] Report failed", e instanceof Error ? e.message : e);
  } finally {
    reporting = false;
  }
}
async function grantTick() {
  if (granting) return;
  granting = true;
  try {
    const hosts = await recomputeAllGrants();
    const pressured = hosts.filter((h) => h.pressure_state !== "NORMAL");
    if (pressured.length) {
      console.log(
        "[grants] pressure",
        pressured.map((h) => `${h.host_id}:${h.pressure_state}`).join(" ")
      );
    }
  } catch (e) {
    console.error("[grants]", e);
  } finally {
    granting = false;
  }
}
async function relayTick() {
  if (syncingRelays) return;
  syncingRelays = true;
  try {
    const r = await syncRelays();
    if (r.updated) console.log(`[relay] Synced ${r.checked} items, updated ${r.updated}`);
  } catch (e) {
    console.error("[relay]", e);
  } finally {
    syncingRelays = false;
  }
}
server.listen(config.port, config.host, () => {
  console.log(`scheduler listening on ${config.host}:${config.port}`);
  if (!authEnabled()) {
    console.warn("[auth] No PCS public key or AUTH_TOKEN configured: instance/worker endpoints are unauthenticated and must not be exposed");
  } else if (process.env.PCS_PUBLIC_KEY_FILE || process.env.PCS_PUBLIC_KEY) {
    console.log("[auth] Instance auth: ES256 JWT verification");
  } else {
    console.warn("[auth] Instance auth: shared AUTH_TOKEN (transitional)");
  }
  if (config.loops) {
    timer = setInterval(tick, config.tickMs);
    void tick();
    if (config.federationToken) {
      federationTimer = setInterval(reportUpstream, config.federationIntervalMs);
      void reportUpstream();
    }
    relayTimer = setInterval(relayTick, config.relaySyncMs);
    grantTimer = setInterval(grantTick, config.grantIntervalMs);
    void grantTick();
  }
});
async function shutdown(signal) {
  console.log(`
${signal}: shutting down\u2026`);
  if (timer) clearInterval(timer);
  if (federationTimer) clearInterval(federationTimer);
  if (relayTimer) clearInterval(relayTimer);
  server.close();
  await pool.end().catch(() => {
  });
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
