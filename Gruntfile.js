/*jslint node:true*/
module.exports = function (grunt) {
  "use strict";
  grunt.initConfig({
    pkg: grunt.file.readJSON('package.json'),
    jshint: {
      grunt: [ 'Gruntfile.js' ],
      src: [ 'src/**/*.js'  ],
      options: {
        jshintrc: true
      }
    },
    browserify: {
      dist: {
        files: {
          'dist/socialprovider.js': [ 'src/socialprovider.js' ]
        },
        options: {
          alias : ['./lib/net.js:net', './lib/tls.js:tls', './lib/lodash.js:lodash'],
          ignore : ['axon']
        }
      }
    }
  });
  grunt.loadNpmTasks('grunt-browserify');
  grunt.loadNpmTasks('grunt-contrib-jshint');
  
  // Compile into build/
  grunt.registerTask('build', [
    'jshint',
    'browserify'
  ]);

  grunt.registerTask('default', [ 'build' ]);
};