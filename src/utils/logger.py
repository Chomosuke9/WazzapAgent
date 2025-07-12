import logging


def create_logger(name, level : 10|20|30|40|50 = 10) -> logging.Logger:
    """
    Create logger with name and level.
    :param name: Name of the logger
    :param level: Level of the logger [10, 20, 30, 40, 50]
    :return: logger
    """
    logger = logging.getLogger(name=name)
    logger.setLevel(level)
    console_handler = logging.StreamHandler()
    console_handler.setFormatter(logging.Formatter('%(asctime)s - %(levelname)s - %(message)s'))
    logger.addHandler(console_handler)
    return logger
