define(function (require) {
  var _ = require('lodash');

  var html = require('text!components/doc_table/doc_table.html');
  var getSort = require('components/doc_table/lib/get_sort');
  var saveAs = require('file_saver');

  require('css!components/doc_table/doc_table.css');
  require('directives/truncated');
  require('directives/infinite_scroll');
  require('components/doc_table/components/table_header');
  require('components/doc_table/components/table_row');

  require('modules').get('kibana')
  .directive('docTable', function (config, Notifier, getAppState, courier) {
    return {
      restrict: 'E',
      template: html,
      scope: {
        sorting: '=',
        columns: '=',
        hits: '=?', // You really want either hits & indexPattern, OR searchSource
        indexPattern: '=?',
        searchSource: '=?',
        infiniteScroll: '=?',
        filter: '=?',
      },
      link: function ($scope) {
        var notify = new Notifier();
        $scope.limit = 50;
        $scope.persist = {
          sorting: $scope.sorting,
          columns: $scope.columns
        };

        var prereq = (function () {
          var fns = [];

          return function register(fn) {
            fns.push(fn);

            return function () {
              fn.apply(this, arguments);

              if (fns.length) {
                _.pull(fns, fn);
                if (!fns.length) {
                  $scope.$root.$broadcast('ready:vis');
                }
              }
            };
          };
        }());

        $scope.addRows = function () {
          $scope.limit += 50;
        };

        // This exists to fix the problem of an empty initial column list not playing nice with watchCollection.
        $scope.$watch('columns', function (columns) {
          if (columns.length !== 0) return;

          var $state = getAppState();
          $scope.columns.push('_source');
          if ($state) $state.replace();
        });

        $scope.$watchCollection('columns', function (columns, oldColumns) {
          if (oldColumns.length === 1 && oldColumns[0] === '_source' && $scope.columns.length > 1) {
            _.pull($scope.columns, '_source');
          }

          if ($scope.columns.length === 0) $scope.columns.push('_source');
        });


        $scope.$watch('searchSource', prereq(function (searchSource) {
          if (!$scope.searchSource) return;

          $scope.indexPattern = $scope.searchSource.get('index');

          $scope.searchSource.size(config.get('discover:sampleSize'));
          $scope.searchSource.sort(getSort($scope.sorting, $scope.indexPattern));

          // Set the watcher after initialization
          $scope.$watchCollection('sorting', function (newSort, oldSort) {
            // Don't react if sort values didn't really change
            if (newSort === oldSort) return;
            $scope.searchSource.sort(getSort(newSort, $scope.indexPattern));
            $scope.searchSource.fetchQueued();
          });

          $scope.$on('$destroy', function () {
            if ($scope.searchSource) $scope.searchSource.destroy();
          });

          // TODO: we need to have some way to clean up result requests
          $scope.searchSource.onResults().then(function onResults(resp) {
            // Reset infinite scroll limit
            $scope.limit = 50;

            // Abort if something changed
            if ($scope.searchSource !== $scope.searchSource) return;

            $scope.hits = resp.hits.hits;

            return $scope.searchSource.onResults().then(onResults);
          }).catch(notify.fatal);

          $scope.searchSource.onError(notify.error).catch(notify.fatal);
        }));

        $scope.exportAsCsv = function (formatted) {
          var csv = {
            separator: config.get('csv:separator'),
            quoteValues: config.get('csv:quoteValues')
          };

          var rows = $scope.hits;
          var columns = $scope.columns;
          var nonAlphaNumRE = /[^a-zA-Z0-9]/;
          var allDoubleQuoteRE = /"/g;

          function escape(val) {
            if (_.isObject(val)) val = val.valueOf();
            val = String(val);
            if (csv.quoteValues && nonAlphaNumRE.test(val)) {
              val = '"' + val.replace(allDoubleQuoteRE, '""') + '"';
            }
            return val;
          }

          function formatField(value, name) {
            var defaultFormat = courier.indexPatterns.fieldFormats.defaultByType.string;
            var field = $scope.indexPattern.fields.byName[name];
            var formatter = (field && field.format) ? field.format : defaultFormat;

            return formatter.convert(value);
          }

          function formatRow(row) {
            $scope.indexPattern.flattenHit(row);
            row.$$_formatted = row.$$_formatted || _.mapValues(row.$$_flattened, formatField);
            return row.$$_formatted;
          }

          // get column values for each row
          var csvRows = rows.map(function (row, i) {
            return columns.map(function (column, j) {
              var val;

              if (formatted) {
                val = (row.$$_formatted || formatRow(row))[column];
              } else {
                val = (row.$$_flattened || formatRow(row))[column];
              }

              val = (val == null) ? '' : val;

              return val;
            });
          });

          // escape each cell in each row
          csvRows = csvRows.map(function (row, i) {
            return row.map(escape);
          });

          // add the columns to the rows
          csvRows.unshift(columns.map(escape));

          var data = csvRows.map(function (row) {
            return row.join(csv.separator) + '\r\n';
          }).join('');

          saveAs(new Blob([data], { type: 'text/plain' }), 'export.csv');
        };
      }
    };
  });
});
