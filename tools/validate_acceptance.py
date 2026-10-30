"""Validate portable acceptance by independently rerunning the supplied archive.

JSON cannot prove who wrote it. No report-only acceptance path exists: even a
complete hand-written success claim must survive fresh execution of the ZIP.
"""
import argparse
import json
from pathlib import Path

from qualify_portable import CHECKS, qualify


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('report', type=Path)
    parser.add_argument('--archive', required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        report = json.loads(args.report.read_text(encoding='utf-8'))
        if (not isinstance(report, dict) or set(report) != {
                'schema_version', 'archive_sha256', 'verdict', 'checks', 'error'}
                or type(report['schema_version']) is not int or report['schema_version'] != 1
                or report['verdict'] != 'pass' or report['error'] is not None
                or not isinstance(report['checks'], dict) or set(report['checks']) != set(CHECKS)
                or any(value is not True for value in report['checks'].values())):
            raise ValueError('incomplete or failed qualification report')
        actual = qualify(args.archive)
        if actual['verdict'] != 'pass' or actual != report:
            raise ValueError('report does not match independent qualification: ' + str(actual['error']))
    except (OSError, ValueError) as error:
        print('REFUSED: ' + str(error))
        return 1
    print('PASS: report matches independently qualified archive')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
