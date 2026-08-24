import React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from './Button.js';

const PAGE_SIZES = [10, 25, 50] as const;

export type PageSize = (typeof PAGE_SIZES)[number];

export interface PaginationProps {
  readonly page: number;
  readonly pageSize: PageSize;
  readonly totalItems: number;
  readonly onPageChange: (page: number) => void;
  readonly onPageSizeChange: (pageSize: PageSize) => void;
  readonly disabled?: boolean;
  readonly itemLabel?: string;
}

type PaginationItem = number | 'ellipsis-start' | 'ellipsis-end';

function getPaginationItems(currentPage: number, totalPages: number): PaginationItem[] {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }

  const pages = new Set([1, totalPages, currentPage - 1, currentPage, currentPage + 1]);
  const visiblePages = [...pages]
    .filter((page) => page >= 1 && page <= totalPages)
    .toSorted((left, right) => left - right);
  const items: PaginationItem[] = [];

  visiblePages.forEach((page, index) => {
    const previousPage = visiblePages[index - 1];
    if (previousPage !== undefined && page - previousPage > 1) {
      items.push(index === 1 ? 'ellipsis-start' : 'ellipsis-end');
    }
    items.push(page);
  });

  return items;
}

export const Pagination: React.FC<PaginationProps> = ({
  page,
  pageSize,
  totalItems,
  onPageChange,
  onPageSizeChange,
  disabled = false,
  itemLabel = 'items',
}) => {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const safePage = Math.min(Math.max(page, 1), totalPages);
  const firstItem = totalItems === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const lastItem = Math.min(safePage * pageSize, totalItems);
  const pageItems = getPaginationItems(safePage, totalPages);

  return (
    <nav className="pagination" aria-label={`${itemLabel} pagination`}>
      <p className="pagination-summary" aria-live="polite">
        Showing <strong>{firstItem}</strong>–<strong>{lastItem}</strong> of{' '}
        <strong>{totalItems}</strong> {itemLabel}
      </p>

      <div className="pagination-controls">
        <label className="pagination-page-size">
          <span>Rows per page</span>
          <select
            className="pagination-page-size-select"
            value={pageSize}
            disabled={disabled}
            onChange={(event) => onPageSizeChange(Number(event.target.value) as PageSize)}
          >
            {PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>

        <div className="pagination-pages">
          <Button
            type="button"
            variant="secondary"
            className="pagination-direction"
            aria-label="Go to previous page"
            disabled={disabled || safePage === 1}
            onClick={() => onPageChange(safePage - 1)}
          >
            <ChevronLeft size={16} aria-hidden="true" />
            <span>Previous</span>
          </Button>

          <div className="pagination-numbers" aria-label="Choose a page">
            {pageItems.map((item) =>
              typeof item === 'number' ? (
                <Button
                  type="button"
                  key={item}
                  variant={item === safePage ? 'primary' : 'secondary'}
                  className="pagination-number"
                  aria-label={`Go to page ${item}`}
                  aria-current={item === safePage ? 'page' : undefined}
                  disabled={disabled}
                  onClick={() => onPageChange(item)}
                >
                  {item}
                </Button>
              ) : (
                <span key={item} className="pagination-ellipsis" aria-hidden="true">
                  …
                </span>
              ),
            )}
          </div>

          <Button
            type="button"
            variant="secondary"
            className="pagination-direction"
            aria-label="Go to next page"
            disabled={disabled || safePage === totalPages}
            onClick={() => onPageChange(safePage + 1)}
          >
            <span>Next</span>
            <ChevronRight size={16} aria-hidden="true" />
          </Button>
        </div>
      </div>
    </nav>
  );
};
