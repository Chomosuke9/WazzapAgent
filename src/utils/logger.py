import logging
import sys

# Define a type hint for logger levels for clarity
LoggerLevel = int

def create_logger(name: str, level: LoggerLevel = logging.DEBUG) -> logging.Logger:
    """
    Creates, configures, and returns a logger instance.

    Args:
        name: The name of the logger, typically __name__.
        level: The logging level, e.g., logging.DEBUG, logging.INFO.
               Defaults to logging.DEBUG.

    Returns:
        A configured logging.Logger instance.
    """
    logger = logging.getLogger(name)
    logger.setLevel(level)

    # Prevent adding duplicate handlers if logger is already configured
    if not logger.handlers:
        console_handler = logging.StreamHandler(sys.stdout)
        formatter = logging.Formatter(
            '%(asctime)s - %(name)s - %(levelname)s - %(message)s'
        )
        console_handler.setFormatter(formatter)
        logger.addHandler(console_handler)

    return logger
