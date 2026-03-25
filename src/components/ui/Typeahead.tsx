import { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';

export type TypeaheadOption = {
  id: string;
  label: string;
};

type TypeaheadProps = {
  options: TypeaheadOption[];
  selectedOptions: string[];
  onChange: (selectedOptions: string[]) => void;
  placeholder?: string;
  noOptionsMessage?: string;
  noSelectionMessage?: string;
  isLoading?: boolean;
  className?: string;
  dropdownZIndex?: string;
  renderOption?: (option: TypeaheadOption, isSelected: boolean) => ReactNode;
};

export default function Typeahead({
  options,
  selectedOptions,
  onChange,
  placeholder = 'Search...',
  noOptionsMessage = 'No options found',
  noSelectionMessage = 'No options selected',
  isLoading = false,
  className = '',
  dropdownZIndex = 'z-10',
  renderOption,
}: TypeaheadProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const comboboxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputWrapperRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [dropdownPos, setDropdownPos] = useState({ top: 0, left: 0, width: 0 });

  const updateDropdownPos = useCallback(() => {
    if (inputWrapperRef.current) {
      const rect = inputWrapperRef.current.getBoundingClientRect();
      setDropdownPos({
        top: rect.bottom + 4,
        left: rect.left,
        width: rect.width,
      });
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    updateDropdownPos();
    window.addEventListener('scroll', updateDropdownPos, true);
    window.addEventListener('resize', updateDropdownPos);
    return () => {
      window.removeEventListener('scroll', updateDropdownPos, true);
      window.removeEventListener('resize', updateDropdownPos);
    };
  }, [isOpen, updateDropdownPos]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        comboboxRef.current &&
        !comboboxRef.current.contains(target) &&
        (!dropdownRef.current || !dropdownRef.current.contains(target))
      ) {
        setIsOpen(false);
        setIsFocused(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  const handleOptionToggle = (optionId: string) => {
    if (selectedOptions.includes(optionId)) {
      onChange(selectedOptions.filter((id) => id !== optionId));
    } else {
      onChange([...selectedOptions, optionId]);
    }
  };

  const handleRemoveOption = (optionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    onChange(selectedOptions.filter((id) => id !== optionId));
  };

  const filteredOptions = options.filter((option) => {
    return option.label.toLowerCase().includes(searchTerm.toLowerCase());
  });

  const selectedOptionDetails = selectedOptions.map((id) => {
    const option = options.find((o) => o.id === id);
    return {
      id,
      label: option ? option.label : 'Unknown Option',
    };
  });

  if (isLoading) {
    return (
      <div className='space-y-2'>
        <div className='h-10 w-full animate-pulse rounded bg-gray-200'></div>
        <div className='h-6 w-full animate-pulse rounded bg-gray-200'></div>
        <div className='h-6 w-full animate-pulse rounded bg-gray-200'></div>
      </div>
    );
  }

  return (
    <div className={`space-y-1 ${className}`} ref={comboboxRef}>
      <div ref={inputWrapperRef}>
        <div
          className={`flex items-center rounded-lg border ${
            isFocused
              ? 'border-primary ring-1 ring-primary'
              : 'border-border-default'
          } bg-bg-card px-2 py-1 transition-colors duration-200`}
        >
          <Search className='mr-2 text-text-muted w-4 h-4' />
          <input
            ref={inputRef}
            type='text'
            placeholder={placeholder}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            onFocus={() => {
              setIsOpen(true);
              setIsFocused(true);
            }}
            className='w-full bg-transparent text-text-primary placeholder-text-muted border-0 outline-none focus:outline-none focus:ring-0 text-sm py-0'
            style={{ outline: 'none', boxShadow: 'none', border: 'none' }}
          />
        </div>
      </div>

      {isOpen && (
        <div
          ref={dropdownRef}
          className='fixed z-[9999] max-h-60 overflow-auto rounded-md bg-bg-card py-1 shadow-lg border border-border-default'
          style={{
            top: dropdownPos.top,
            left: dropdownPos.left,
            width: dropdownPos.width,
          }}
        >
          {filteredOptions.length === 0 ? (
            <div className='px-3 py-1.5 text-sm text-text-muted'>
              {noOptionsMessage}
            </div>
          ) : (
            filteredOptions.map((option) => (
              <div
                key={option.id}
                onClick={() => handleOptionToggle(option.id)}
                className={`cursor-pointer px-3 py-1.5 text-sm ${
                  selectedOptions.includes(option.id)
                    ? 'bg-primary/10 text-primary'
                    : 'text-text-primary hover:bg-bg-elevated'
                }`}
              >
                {renderOption ? (
                  renderOption(option, selectedOptions.includes(option.id))
                ) : (
                  <div className='flex items-center'>
                    <input
                      type='checkbox'
                      checked={selectedOptions.includes(option.id)}
                      readOnly
                      className='mr-2 h-4 w-4 rounded border-border-default text-primary focus:ring-primary'
                    />
                    <span>{option.label}</span>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}

      <div className='flex flex-wrap gap-1.5'>
        {selectedOptionDetails.map((option) => (
          <div
            key={option.id}
            className='flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary'
          >
            <span className='mr-1'>{option.label}</span>
            <button
              type='button'
              onClick={(e) => handleRemoveOption(option.id, e)}
              className='ml-1 rounded-full p-0.5 hover:bg-primary/20'
            >
              <X className='h-2.5 w-2.5' />
            </button>
          </div>
        ))}
        {selectedOptions.length === 0 && (
          <div className='text-xs text-text-muted'>
            {noSelectionMessage}
          </div>
        )}
      </div>
    </div>
  );
}
